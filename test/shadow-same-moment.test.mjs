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
// The moment the OBSERVATION saw, which is the one the projection is built from.
// Two more threads and two more resolved: an ordinary few seconds on an actively
// reviewed pull request.
const OBSERVED = { readable: true, total: 12, unresolved: 7, seen: 12 };
const PROJECTION = { readable: true, total: 12, open: 7, resolved: 5, unspilledCritical: 0, rounds: 1 };
const THREAD_OBS = { source: "codexbot", kind: "review_thread", external_id: "t11",
                     payload: { thread_id: "t11", is_resolved: false, body: "x" }, event_at: 1 };

const ctxFor = (dir, extra = {}) => ({
  nwo: NWO, profile, db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
  execute: false, shadow: true, running: 0,
  openPrs: () => [7],
  evaluate: () => evaluation(BEFORE),
  publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
  // One read, reporting both the observations AND the counts it saw. The daemon
  // must compare against these, not against evaluate's older reading and not
  // against a second call taken afterwards.
  observe: () => ({ observations: [THREAD_OBS], incomplete: false, threads: OBSERVED }),
  derivePr: () => ({}),
  reviewState: () => PROJECTION,
  ...extra,
});

// ── the fix: a moved pull request is not a disagreement ──────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-moment-"));
  const ctx = ctxFor(dir);
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
    // The observation and the projection genuinely disagree at ONE moment: the
    // derivation has lost a thread the same read saw.
    reviewState: () => ({ readable: true, total: 11, open: 7, resolved: 4, unspilledCritical: 0, rounds: 1 }),
  });
  await tick(ctx);
  const d = divergences(ctx.db, NWO);
  check(d.length === 1 && /thread count differs/.test(d[0].last_divergence ?? ""),
    "control: a genuine disagreement at one moment is still recorded", JSON.stringify(d));
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── no observation this tick means nothing to compare against ────────────────
//
// Not "compare the older reading anyway". Without a snapshot from this tick, the
// projection would be held against a reading from a different moment, which is
// the whole defect. A tick that learned nothing counts as nothing.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-quiet-"));
  const ctx = ctxFor(dir, { observe: () => { throw new Error("must not observe when the PR has not moved"); } });
  // Matches the evaluation's updatedAt, and ingested just now, so neither the
  // change signal nor the staleness window asks for another observation.
  ctx.lastIngest = new Map([[7, { updatedAt: "2026-08-22T10:00:00Z", at: Date.now() }]]);
  await tick(ctx);
  const row = ctx.db.prepare("SELECT comparisons, agreements, incomparable FROM review_shadow WHERE nwo=? AND pr=?").get(NWO, 7);
  check(row?.incomparable === 1 && row?.comparisons === 0,
    "a tick with no observation is INCOMPARABLE, not an agreement and not a divergence", JSON.stringify(row));
  check(divergences(ctx.db, NWO).length === 0, "and raises no divergence", "");
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── `updatedAt` is not a complete change signal ──────────────────────────────
//
// MEASURED 2026-08-22 on revnix/reeve #4: resolving a review thread, and
// unresolving one, leave `pull_request.updated_at` byte-identical. So a pull
// request whose only activity is threads being resolved looks unchanged, the
// ingest is skipped forever, and the projection keeps counts that stopped being
// true — the fail-OPEN direction for PR-5, and a shadow that never compares.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-stale-"));
  let observed = 0;
  const ctx = ctxFor(dir, { observe: () => { observed++; return { observations: [THREAD_OBS], incomplete: false, threads: OBSERVED }; } });
  // The pull request has not moved by GitHub's reckoning — and reeve last looked
  // an hour ago, which is well past the window the fold itself calls stale.
  ctx.lastIngest = new Map([[7, { updatedAt: "2026-08-22T10:00:00Z", at: Date.now() - 3600_000 }]]);
  await tick(ctx);
  check(observed === 1, "an unchanged pull request is re-observed once its projection goes stale", `observed=${observed}`);
  const row = ctx.db.prepare("SELECT comparisons, agreements FROM review_shadow WHERE nwo=? AND pr=?").get(NWO, 7);
  check(row?.comparisons === 1 && row?.agreements === 1,
    "so the shadow keeps learning from it instead of stalling", JSON.stringify(row));
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── an ingest that FAILED leaves nothing to compare against ──────────────────
//
// The observation succeeded, so its counts describe this moment — but the
// projection is still built from the PREVIOUS inbox, because the write never
// landed. Comparing them would record a storage failure as the derivation
// disagreeing, which is the confusion this whole change exists to remove.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-ingestfail-"));
  const ctx = ctxFor(dir, {
    observe: () => ({ observations: [THREAD_OBS], incomplete: false, threads: OBSERVED }),
    ingest: () => { throw new Error("disk full"); },
  });
  await tick(ctx);
  const row = ctx.db.prepare("SELECT comparisons, agreements, incomparable FROM review_shadow WHERE nwo=? AND pr=?").get(NWO, 7);
  check(row?.incomparable === 1 && row?.comparisons === 0,
    "an observation that never reached the database is not a reading of the same moment", JSON.stringify(row));
  check(divergences(ctx.db, NWO).length === 0, "and a storage failure is not a divergence", "");
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── an incomplete observation is INCOMPARABLE too ────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-unread-"));
  const ctx = ctxFor(dir, {
    // The thread pages did not all come back, so the counts describe part of a
    // pull request. compare() refuses an unreadable side on its own terms.
    observe: () => ({ observations: [THREAD_OBS], incomplete: true,
                      threads: { readable: false, total: 12, unresolved: null, seen: 4 } }),
  });
  await tick(ctx);
  const row = ctx.db.prepare("SELECT comparisons, agreements, incomparable FROM review_shadow WHERE nwo=? AND pr=?").get(NWO, 7);
  check(row?.incomparable === 1 && row?.comparisons === 0,
    "an observation that did not see the whole pull request teaches nothing", JSON.stringify(row));
  check(divergences(ctx.db, NWO).length === 0, "and is not a divergence", "");
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
