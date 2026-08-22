// The shadow comparison must hold two readings of the SAME MOMENT.
//
// It did not. The live read happens inside evaluate(); the ingest runs after it;
// the projection is built from what that ingest just wrote. A pull request that
// moved in between was therefore recorded as the DERIVATION disagreeing, which
// is a different claim entirely and the one the whole instrument exists to make.
//
// Measured 2026-08-22: all four of the week's recorded divergences agreed
// exactly when the pair was taken together, and the probe's own ingest was still
// inserting five threads on #1128 — the count that PR's divergence reported.
//
// `compare` itself was never wrong. This drives the DAEMON, because the defect
// was in which reading it handed over, and no test drove that path at all.
import { tick } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";
import { divergences } from "../src/review/shadow.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r";
const HEAD = "a".repeat(40);
const profile = {
  identity: { key: NWO, defaultBranch: "main" },
  authority: { policy: "propose_and_merge" },
  ci: { provider: "github-actions", requiredChecks: [] },
  watch: { maxWorkers: 1 },
  reviewers: [{ login: "codexbot", kind: "blocking", trigger: false }],
};

const cl = (id, state, detail = "") => ({ id, state, detail });
const evaluation = threads => ({
  ok: true, pr: 7, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
  updatedAt: "2026-08-22T10:00:00Z",
  verdict: { state: "PASS", summary: "ok",
             clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"].map(id => cl(id, "PASS")) },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  checks: { verdict: "GREEN", caused: [], failing: [] },
  reviewers: [], threads, settled: { settled: true },
});

// The moment the live read in evaluate() saw: 10 threads, 3 resolved.
const BEFORE = { readable: true, total: 10, unresolved: 7, seen: 10 };
// The moment everything after the ingest describes: two more threads, and two
// more resolved. This is an ordinary few seconds on an actively reviewed PR.
const AFTER = { readable: true, total: 12, unresolved: 7, seen: 12 };
const PROJECTION = { readable: true, total: 12, open: 7, resolved: 5, unspilledCritical: 0, rounds: 1 };

const ctxFor = (dir, extra = {}) => ({
  nwo: NWO, profile, db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
  execute: false, shadow: true, running: 0,
  openPrs: () => [7],
  evaluate: () => evaluation(BEFORE),
  publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
  // The ingest wrote: two threads appeared between the live read and now.
  observe: () => ({ observations: [], incomplete: false }),
  derivePr: () => ({}),
  reviewState: () => PROJECTION,
  // The live state as it is AFTER the ingest, which is the moment the projection
  // describes. The daemon should ask for this rather than reuse the older one.
  readThreads: () => AFTER,
  ...extra,
});

// ── the fix: a moved pull request is not a disagreement ──────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-moment-"));
  const ctx = ctxFor(dir, { observe: () => ({ observations: [{ source: "codexbot", kind: "review_thread", external_id: "t11", payload: { thread_id: "t11", is_resolved: false, body: "x" }, event_at: 1 }], incomplete: false }) });
  await tick(ctx);
  const d = divergences(ctx.db, NWO);
  check(d.length === 0,
    "a pull request that moved between the two reads is not recorded as the derivation disagreeing",
    JSON.stringify(d));
  const row = ctx.db.prepare("SELECT comparisons, agreements FROM review_shadow WHERE nwo=? AND pr=?").get(NWO, 7);
  check(row?.comparisons === 1 && row?.agreements === 1,
    "and it counts as a comparison that AGREED, not as one skipped", JSON.stringify(row));
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── the control: a real disagreement still lands ─────────────────────────────
//
// Without this the fix could be "never compare anything", which would pass the
// case above and destroy the instrument.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-real-"));
  const ctx = ctxFor(dir, {
    observe: () => ({ observations: [{ source: "codexbot", kind: "review_thread", external_id: "t11", payload: { thread_id: "t11", is_resolved: false, body: "x" }, event_at: 1 }], incomplete: false }),
    // The live state and the projection genuinely disagree at the same moment:
    // the derivation has lost a thread.
    readThreads: () => ({ readable: true, total: 12, unresolved: 7, seen: 12 }),
    reviewState: () => ({ readable: true, total: 11, open: 7, resolved: 4, unspilledCritical: 0, rounds: 1 }),
  });
  await tick(ctx);
  const d = divergences(ctx.db, NWO);
  check(d.length === 1 && /thread count differs/.test(d[0].last_divergence ?? ""),
    "control: a genuine disagreement at one moment is still recorded", JSON.stringify(d));
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── a quiet pull request costs no extra call ─────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-quiet-"));
  let reread = 0;
  const ctx = ctxFor(dir, {
    observe: () => ({ observations: [], incomplete: false }),      // nothing to write
    readThreads: () => { reread++; return AFTER; },
    reviewState: () => ({ readable: true, total: 10, open: 7, resolved: 3, unspilledCritical: 0, rounds: 1 }),
  });
  await tick(ctx);
  check(reread === 0, "an ingest that wrote nothing does not pay for a second live read", String(reread));
  const row = ctx.db.prepare("SELECT comparisons, agreements FROM review_shadow WHERE nwo=? AND pr=?").get(NWO, 7);
  check(row?.comparisons === 1 && row?.agreements === 1,
    "and the reading it already had is compared, and agrees", JSON.stringify(row));
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── an unreadable re-read is INCOMPARABLE, never a disagreement ──────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-unread-"));
  const ctx = ctxFor(dir, {
    observe: () => ({ observations: [{ source: "codexbot", kind: "review_thread", external_id: "t11", payload: { thread_id: "t11", is_resolved: false, body: "x" }, event_at: 1 }], incomplete: false }),
    readThreads: () => ({ readable: false, why: "graphql timed out" }),
  });
  await tick(ctx);
  const row = ctx.db.prepare("SELECT comparisons, agreements, incomparable FROM review_shadow WHERE nwo=? AND pr=?").get(NWO, 7);
  check(row?.incomparable === 1 && row?.comparisons === 0,
    "a live re-read that failed teaches nothing, and is counted as nothing", JSON.stringify(row));
  check(divergences(ctx.db, NWO).length === 0, "and is not a divergence", "");
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
