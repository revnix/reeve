// PR-4: the gate before the verdict is allowed to read projections.
//
// This is the instrument that decides whether PR-5 is safe, so the way it can
// fail is by being WRONG ABOUT WHAT SHOULD MATCH — and there are two opposite
// ways to get that wrong, both of which make it useless:
//
//   Compare uncleared against unresolved and it diverges on every tick that the
//   clearing rule is working. An instrument that cries wolf on correct behaviour
//   teaches its reader to ignore it, and then it is not an instrument.
//
//   Count an incomparable tick as agreement and the streak becomes a record of
//   not looking. That is absence rendered as success, in the one place built to
//   decide whether absence has been ruled out.
import { compare, record, streak, divergences } from "../src/review/shadow.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r";
const DAY = 86400;
const T = Math.floor(Date.UTC(2026, 7, 21, 12, 0, 0) / 1000);

const live = (total, unresolved, readable = true) => ({ total, unresolved, readable });
const proj = (total, open, resolved, readable = true) => ({ total, open, resolved, readable });

// ── what must match ──────────────────────────────────────────────────────────
{
  // Control: identical views agree.
  const same = compare(live(10, 4), proj(10, 4, 6));
  check(same.comparable && same.agree, "control: two views telling the same story agree", JSON.stringify(same.why));

  check(compare(live(10, 4), proj(9, 4, 5)).agree === false,
    "a differing THREAD COUNT is a real divergence — ingest lost or invented one");
  check(/thread count differs/.test(compare(live(10, 4), proj(9, 4, 5)).why),
    "and says which number differed");

  check(compare(live(10, 4), proj(10, 4, 5)).agree === false,
    "a differing RESOLVED count is a real divergence — both read GitHub's own flag");
}

// ── what must NOT be treated as divergence ───────────────────────────────────
{
  // Six resolved, but only two confirmed by a later round: four are held back.
  // That is the clearing rule working, on every tick, forever.
  const r = compare(live(10, 4), proj(10, 8, 6));
  check(r.agree === true,
    "uncleared EXCEEDING unresolved is not a divergence — it is the clearing rule",
    JSON.stringify(r.why));
  check(/4 resolved thread\(s\) not yet confirmed/.test(r.note ?? ""),
    "and the gap is reported as a note, so a reader can see why", r.note);

  // The reverse is impossible under any rule and IS a defect.
  const bad = compare(live(10, 6), proj(10, 3, 4));
  check(bad.agree === false && /still calls unresolved/.test(bad.why),
    "but clearing a thread GitHub still calls unresolved is a real defect", bad.why);
}

// ── incomparable is neither ──────────────────────────────────────────────────
{
  const truncated = compare(live(10, 4, false), proj(10, 4, 6));
  check(truncated.comparable === false && truncated.agree === false,
    "a truncated live read is not comparable, and not agreement", JSON.stringify(truncated));

  const nostate = compare(live(10, 4), { readable: false, why: "no projection" });
  check(nostate.comparable === false,
    "nor is a projection that refused to answer", JSON.stringify(nostate.why));
  check(/no projection/.test(nostate.why), "and the reason survives", nostate.why);
}

// ── the streak ───────────────────────────────────────────────────────────────
const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-"));
const db = open(join(dir, "s.db"));

{
  // Three days, agreeing, several comparisons each.
  for (let d = 0; d < 3; d++) {
    for (let i = 0; i < 4; i++) record(db, NWO, 1, compare(live(5, 2), proj(5, 2, 3)), T - d * DAY);
  }
  const s = streak(db, NWO, T);
  check(s.days === 3 && s.comparisons === 12,
    "control: three days of agreement over twelve comparisons", JSON.stringify(s));

  // A single divergence on the newest day collapses it to zero.
  record(db, NWO, 2, compare(live(5, 2), proj(4, 2, 2)), T);
  const after = streak(db, NWO, T);
  check(after.days === 0,
    "ONE divergence today ends the streak — the bar is zero, not mostly", JSON.stringify(after));
  check(after.firstDivergence?.day === new Date(T * 1000).toISOString().slice(0, 10),
    "and it names the day to go and explain", JSON.stringify(after.firstDivergence));

  check(divergences(db, NWO).length === 1,
    "the divergence is listed for explanation, not just counted");
  check(/thread count differs/.test(divergences(db, NWO)[0].last_divergence ?? ""),
    "with the reason attached", divergences(db, NWO)[0].last_divergence);
}

// ── a quiet day neither extends nor breaks ───────────────────────────────────
{
  const dir2 = mkdtempSync(join(tmpdir(), "reeve-shadow2-"));
  const db2 = open(join(dir2, "s.db"));

  record(db2, NWO, 1, compare(live(5, 2), proj(5, 2, 3)), T - 2 * DAY);   // day -2: agreed
  record(db2, NWO, 1, compare(live(5, 2, false), proj(5, 2, 3)), T - DAY); // day -1: nothing comparable
  record(db2, NWO, 1, compare(live(5, 2), proj(5, 2, 3)), T);              // today: agreed

  const s = streak(db2, NWO, T);
  check(s.days === 2,
    "a day where nothing could be compared is SKIPPED, not counted as agreement",
    JSON.stringify(s));

  // The important half: it must not be counted as a day of agreement.
  const onlyQuiet = mkdtempSync(join(tmpdir(), "reeve-shadow3-"));
  const db3 = open(join(onlyQuiet, "s.db"));
  for (let d = 0; d < 6; d++) record(db3, NWO, 1, compare(live(5, 2, false), proj(5, 2, 3)), T - d * DAY);
  check(streak(db3, NWO, T).days === 0,
    "six days of unreadable reads is a streak of ZERO, not six — absence is not success",
    JSON.stringify(streak(db3, NWO, T)));

  db2.close(); db3.close();
  rmSync(dir2, { recursive: true, force: true });
  rmSync(onlyQuiet, { recursive: true, force: true });
}

// ── the recorded rollup ──────────────────────────────────────────────────────
{
  const row = db.prepare("SELECT * FROM review_shadow WHERE pr=1 ORDER BY day DESC LIMIT 1").get();
  check(row.comparisons === 4 && row.agreements === 4,
    "a day rolls up rather than storing a row per tick", JSON.stringify(row));

  record(db, NWO, 1, compare(live(5, 2, false), proj(5, 2, 3)), T);
  const after = db.prepare("SELECT * FROM review_shadow WHERE pr=1 ORDER BY day DESC LIMIT 1").get();
  check(after.comparisons === 4 && after.incomparable === 1,
    "and an incomparable tick lands in its own column, inflating neither side",
    JSON.stringify(after));
}

// ── the wiring: an incomplete read must REACH the fold ───────────────────────
//
// Measured in production on day one of the shadow week. The daemon read
// `ctx.lastIngestIncomplete` — a name nothing ever assigned — so `complete` was
// always true, and a truncated observation produced a projection that answered
// confidently from a partial view. nextly #1128 reported live 55 against derived
// 50 and it was logged as a DIVERGENCE, when the honest answer is that nothing
// was comparable because the read had not finished.
//
// The unit tests could not catch it: they pass `complete` explicitly. Only the
// call site can be wrong, so only the call site can be asserted. This is the
// fourth parameter in one day whose optional default silently switched its own
// rule off.
{
  const src = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");

  const setter = (src.match(/ingestComplete[^\n]*set\([^\n]*/) ?? [null])[0];
  check(!!setter, "control: the tick records whether an observation was whole", String(setter));
  check(/!seen\.incomplete/.test(setter ?? ""),
    "and records it from what observe() actually reported", String(setter));

  const call = (src.match(/derivePr\)\(db, nwo, pr, profile,[\s\S]{0,180}?\}\)/) ?? [null])[0];
  check(!!call && /complete:/.test(call), "control: found the derive call site", String(call));
  check(/complete: ctx\.ingestComplete\?\.get\?\.\(pr\) === true/.test(call ?? ""),
    "the fold is told, and a PR never wholly observed is NOT complete",
    String(call));

  // The name that was read and never written must be gone entirely, or the next
  // reader finds two mechanisms and trusts the dead one.
  check(!/lastIngestIncomplete/.test(src),
    "and the never-assigned name it replaced is gone");
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
