// settle() is a correct pure reducer, and evaluatePr() never gave it real input:
// it read the checks ONCE and then called settle() three times over the same
// in-memory rows, so a check set was declared stable on its first observation.
// The source comment claimed "the watcher in the daemon spaces them over real
// time" -- nothing persisted settlement between ticks, so it did not.
//
// That matters more than it sounds: the shadow period's acceptance criterion is
// seven days with ZERO false blocks, and settling on first sight manufactures
// exactly those. A correct helper does not prove its caller supplies the right
// state -- which is the audit's own summary of this whole class of defect.
import { open, loadSettlement, saveSettlement } from "../src/db/ops.mjs";
import { settle } from "../src/github/reconciler.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-settle-"));
const path = join(dir, "s.db");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const run = (name, conclusion) => ({ name, conclusion, status: "completed" });
const green = sha => ({ verdict: "GREEN", sha, rows: [run("a", "success"), run("b", "success")], why: "2 check(s) all passing" });

// One tick: load what the last tick saw, fold ONE reading in, save. This is the
// shape evaluatePr must use.
function tick(db, nwo, pr, reading, at) {
  const prior = loadSettlement(db, nwo, pr);
  const next = settle(prior, reading);
  saveSettlement(db, nwo, pr, next, at);
  return next;
}

let db = open(path);

// --- the positive control, and the defect it replaces ------------------------
{
  // The OLD shape: three settle() calls over one reading. If this does not
  // report settled, the defect being fixed never existed and the test is vacuous.
  let s = null;
  for (let i = 0; i < 3; i++) s = settle(s, green("aaa"));
  check(s.settled === true,
    "control: the old three-calls-one-reading shape did settle immediately", JSON.stringify(s));
}

// --- settlement across real ticks -------------------------------------------
{
  const a = tick(db, "o/r", 1, green("aaa"), 100);
  check(a.settled === false && a.streak === 1, "tick 1 of a green set is not settled", JSON.stringify(a));
}
{
  const b = tick(db, "o/r", 1, green("aaa"), 200);
  check(b.settled === false && b.streak === 2, "tick 2 is still not settled", JSON.stringify(b));
}
{
  const c = tick(db, "o/r", 1, green("aaa"), 300);
  check(c.settled === true && c.verdict === "GREEN", "tick 3 settles GREEN", JSON.stringify(c));
}

// --- it must survive a restart ----------------------------------------------
{
  db.close(); db = open(path);
  const d = tick(db, "o/r", 1, green("aaa"), 400);
  check(d.settled === true && d.streak === 4,
    "a restart resumes the streak rather than starting over", JSON.stringify(d));
}

// --- a new head restarts the streak but keeps the floor ----------------------
{
  const e = tick(db, "o/r", 1, { verdict: "GREEN", sha: "bbb", rows: [run("a", "success")], why: "1 check" }, 500);
  check(e.settled === false && e.floor === 2,
    "a new head restarts the streak and keeps the floor, so a shrinking check set cannot pass",
    JSON.stringify(e));
  check(e.verdict === "UNKNOWN", "fewer checks than the floor is UNKNOWN, not green", JSON.stringify(e));
}

// --- two PRs must not share one row -----------------------------------------
{
  tick(db, "o/r", 2, green("zzz"), 600);
  const back = loadSettlement(db, "o/r", 1);
  check(back.sha === "bbb", "a second PR does not overwrite the first PR's settlement", JSON.stringify(back));
}

// --- and two repos with the same PR number must not collide -----------------
{
  tick(db, "other/r", 1, green("qqq"), 700);
  const back = loadSettlement(db, "o/r", 1);
  check(back.sha === "bbb", "another repo's PR 1 does not overwrite this one", JSON.stringify(back));
}

// --- absence needs corroboration; a failure does not ------------------------
// A required check that has not appeared is an ABSENCE. GitHub may not have
// created it yet, and calling that "never reported" on first sight is the same
// absence-read-as-fact error in the opposite direction.
{
  const m = { verdict: "MISSING_REQUIRED", sha: "ccc", rows: [run("a", "success")], why: "required check(s) never reported: CI Gate" };
  const first = tick(db, "o/r", 3, m, 800);
  check(first.settled === false,
    "a missing required check is NOT settled on its first observation", JSON.stringify(first));
  check(first.why === m.why, "and it still carries its reason", JSON.stringify(first.why));
  tick(db, "o/r", 3, m, 900);
  const third = tick(db, "o/r", 3, m, 1000);
  check(third.settled === true && third.verdict === "MISSING_REQUIRED",
    "three consecutive observations do settle it", JSON.stringify(third));
}
{
  // A failing check is PRESENT evidence. More looks will not un-fail it, so it
  // settles at once -- the asymmetry is the point.
  const red = { verdict: "RED", sha: "ddd", rows: [run("a", "failure")], why: "1 check failing" };
  const r = tick(db, "o/r", 4, red, 1100);
  check(r.settled === true && r.verdict === "RED",
    "a RED reading settles immediately: presence of failure is definite", JSON.stringify(r));
}

// --- the record must say how long this head has been observed ---------------
{
  const s = loadSettlement(db, "o/r", 1);
  check(s.firstSeenAt === 500 && s.lastSeenAt === 500,
    "the row records when this head was first and last observed", JSON.stringify(s));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
