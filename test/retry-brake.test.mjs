// "One fix attempt per finding, then escalate" is the rule that stops a fixer
// guessing forever. It was unreachable three times over:
//
//   1. bin/reeve never created ctx.fixAttempts, so the daemon used
//      `ctx.fixAttempts ?? new Map()` -- a fresh map every tick, remembering nothing.
//   2. fingerprint() included the head SHA, and a fix attempt normally pushes a
//      new head, so the SAME surviving failure became a "new" finding each round.
//   3. the daemon never passed `h.fingerprint` to nextAction at all, so the
//      watcher's own cap read `fp = null`, `tried = 0`, and could never fire.
//
// Each of those alone disables the brake. Together they made it decorative.
//
// The identity a cap is counted against must therefore be HEAD-INDEPENDENT: the
// same root cause surviving a fix is a repeat, whatever revision it reappears on.
import { fingerprint, causeKey } from "../src/ci-rootcause.mjs";
import { open, countFixAttempts, recordFixAttempt } from "../src/db/ops.mjs";
import { nextAction, ACTIONS, ESCALATIONS } from "../src/watcher.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const cause = { job: "Lint / Typecheck / Test / Build", step: "Test",
                cause: [{ where: "packages/nextly/src/x.ts:12", message: "expected 1 got 0" }] };
const other = { job: "Browser tests", step: "e2e",
                cause: [{ where: "e2e/a.spec.ts:3", message: "timeout" }] };

// --- identity ---------------------------------------------------------------
{
  const a = causeKey("o/r", cause), b = causeKey("o/r", cause);
  check(a === b && a.length > 0, "control: the same cause yields the same key", `${a} vs ${b}`);
}
{
  check(causeKey("o/r", cause) !== causeKey("o/r", other),
    "control: a different cause yields a different key");
}
{
  // The whole point: a fix pushes a new head, and the failure surviving that push
  // must still count as the SAME finding.
  check(causeKey("o/r", cause) === causeKey("o/r", cause),
    "the cause key does not change when the head does");
  const f1 = fingerprint("o/r", "a".repeat(40), cause);
  const f2 = fingerprint("o/r", "b".repeat(40), cause);
  check(f1 !== f2, "but the occurrence fingerprint still distinguishes heads, for the trail");
  check(!causeKey("o/r", cause).includes("a".repeat(10)),
    "and the cause key contains no revision at all", causeKey("o/r", cause));
}

// --- persistence -------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "reeve-brake-"));
const path = join(dir, "b.db");
let db = open(path);
const K = causeKey("o/r", cause);
{
  check(countFixAttempts(db, "o/r", 7, K) === 0, "control: an unseen cause has no attempts");
  recordFixAttempt(db, "o/r", 7, K, "a".repeat(40), 100);
  check(countFixAttempts(db, "o/r", 7, K) === 1, "an attempt is counted");
}
{
  db.close(); db = open(path);
  check(countFixAttempts(db, "o/r", 7, K) === 1,
    "and it survives a restart, which is what KeepAlive makes routine");
}
{
  // The failure reappears at a NEW head after the fix. This is the exact case the
  // old head-keyed fingerprint let through.
  recordFixAttempt(db, "o/r", 7, K, "b".repeat(40), 200);
  check(countFixAttempts(db, "o/r", 7, K) === 2,
    "a second attempt at a new head increments the SAME cause, it does not start over");
}
{
  check(countFixAttempts(db, "o/r", 8, K) === 0, "another PR with the same cause counts separately");
  check(countFixAttempts(db, "other/r", 7, K) === 0, "and so does another repository");
}

// --- the decision ------------------------------------------------------------
const P = { rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, authority: { policy: "propose_and_merge" } };
const cl = (id, state, detail = "") => ({ id, state, detail });
const allPass = () => ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"].map(id => cl(id, "PASS"));
const redCi = () => allPass().map(c => (c.id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : c));
const ev = (extra = {}) => ({
  pr: 7, state: "open",
  verdict: { state: "BLOCK", clauses: redCi(), summary: "x" },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate" }] },
  ...extra,
});
{
  const d = nextAction(ev(), P, { now: 1000, fingerprint: K, fixAttempts: new Map() });
  check(d.action === ACTIONS.FIX_CI, "control: a red PR with no prior attempt is fixed", JSON.stringify(d.action));
}
{
  // The history the daemon must now supply from the store, rather than from a
  // map it rebuilds empty every tick.
  const d = nextAction(ev(), P, { now: 1000, fingerprint: K, fixAttempts: new Map([[K, 1]]) });
  check(d.action === ACTIONS.ESCALATE, "the same cause a second time escalates instead of guessing again",
    JSON.stringify(d));
  check(d.why === ESCALATIONS.REPEATED_FAILURE, "and says so", JSON.stringify(d.why));
}
{
  // The defect in its original form: without a fingerprint the cap is unreachable,
  // which is precisely what the daemon was doing in production.
  const d = nextAction(ev(), P, { now: 1000, fixAttempts: new Map([[K, 99]]) });
  check(d.action === ACTIONS.FIX_CI,
    "control: with NO fingerprint supplied the cap cannot fire — the shape of the live defect",
    JSON.stringify(d.action));
}


// An attempt the worker was never ALLOWED to make must not be charged. The first
// real dispatch failed with eleven denied tool calls because reeve's own sandbox
// was wrong, and that consumed the pull request's single repair -- so the next
// tick escalated "the same failure survived a second fix" when no fix had ever
// been attempted. Punishing the PR for reeve's misconfiguration is the wrong
// direction, and DENIED escalates anyway, so refunding cannot loop.
{
  const { refundFixAttempt } = await import("../src/db/ops.mjs");
  const K2 = causeKey("o/r", other);
  recordFixAttempt(db, "o/r", 21, K2, "a".repeat(40), 300);
  check(countFixAttempts(db, "o/r", 21, K2) === 1, "control: the attempt was charged");
  refundFixAttempt(db, "o/r", 21, K2);
  check(countFixAttempts(db, "o/r", 21, K2) === 0, "a denied attempt is refunded");
  refundFixAttempt(db, "o/r", 21, K2);
  check(countFixAttempts(db, "o/r", 21, K2) === 0, "and a refund cannot drive the count negative");
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
