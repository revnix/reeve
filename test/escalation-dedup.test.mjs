// An escalation is an EVENT, not a state, so it must be announced when it starts
// and when it changes -- never on every tick. The first launchd run announced the
// same two PRs on all five of its ticks; at a 2.5-minute cadence that is ~576
// phone pushes overnight for two conditions that never changed, which is how an
// unattended system trains its owner to ignore it.
//
// It must also survive a restart: KeepAlive restarts the daemon, and in-memory
// dedup would re-announce everything each time.
import { open } from "../src/db/ops.mjs";
import { announceable } from "../src/daemon.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-esc-"));
const path = join(dir, "esc.db");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const m = o => new Map(Object.entries(o));

let db = open(path);

// Control: a brand-new escalation must announce, or every assertion below is vacuous.
{
  const r = announceable(db, m({ "#925: the branch conflicts with its base": 1 }));
  check(r.fresh.length === 1 && r.fresh[0].why.startsWith("#925"),
    "control: a new escalation announces once", JSON.stringify(r));
}

// The tick that changes nothing must say nothing.
{
  const r = announceable(db, m({ "#925: the branch conflicts with its base": 1 }));
  check(r.fresh.length === 0 && r.cleared.length === 0,
    "an unchanged escalation is silent on the next tick", JSON.stringify(r));
}

// A shared cause that grows from 1 PR to 4 is new information and must re-announce.
{
  const r = announceable(db, m({ "#925: the branch conflicts with its base": 4 }));
  check(r.fresh.length === 1 && r.fresh[0].count === 4,
    "a changed PR count re-announces", JSON.stringify(r));
}

// Restart: KeepAlive gives the daemon a fresh process and a fresh Map. The
// standing set must come from the store, not from memory.
{
  // The rule above is inert unless the daemon PASSES `waiting`: the parameter
// defaults to null, and null filters nothing. A guard that quietly stops applying
// because its input narrowed is the shape this codebase keeps being bitten by.
// --- a tick that could not look at anything retires nothing -------------------
{
  // A tick whose pull-request listing failed still drains the outbox, and a drain
  // can raise a permanent loss that has to be announced. But that tick LOOKED at
  // nothing, so it must not also retire standing causes: an escalation is not
  // resolved because reeve could not check it. Asserted rather than reasoned,
  // because the degraded path passes empty sets and the clearing rule reads them.
  const dir = mkdtempSync(join(tmpdir(), "reeve-degraded-"));
  const db = open(join(dir, "s.db"));

  // A standing cause of each shape: one naming a pull request, one shared.
  announceable(db, new Map([["#7: needs a human", 1], ["a shared cause", 1]]),
               { covered: new Set([7]), waiting: new Set(), finished: new Set(), complete: true });
  const before = db.prepare("SELECT count(*) n FROM escalation").get().n;
  check(before === 2, "control: two causes are standing", String(before));

  // The degraded call, exactly as the tick makes it: nothing covered, not complete.
  const { fresh, cleared } = announceable(db, new Map(),
    { covered: new Set(), waiting: new Set(), finished: new Set(), complete: false });
  check(cleared.length === 0, "a tick that looked at nothing clears nothing", JSON.stringify(cleared));
  check(db.prepare("SELECT count(*) n FROM escalation").get().n === 2,
    "and both causes still stand", "");
  check(fresh.length === 0, "control: and it announced nothing new either", JSON.stringify(fresh));

  // Control: the SAME causes do clear on a tick that did look, so the assertion
  // above is about the degraded scope and not about clearing being broken.
  const done = announceable(db, new Map(), { covered: new Set([7]), waiting: new Set(), finished: new Set(), complete: true });
  check(done.cleared.length === 2, "control: a complete tick retires them both", JSON.stringify(done.cleared));

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

{
  const src = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  const call = (src.match(/announceable\(db, escalations,[\s\S]{0,200}?\}\)/) ?? [null])[0];

  check(!!call && /covered:/.test(call), "control: found the daemon's announceable call site", String(call));
  check(/\bwaiting\b/.test(call ?? ""),
    "and it passes the waiting set, without which WAIT still clears escalations", String(call));
  check(/\bfinished\b/.test(call ?? ""),
    "and the finished set, without which a merged PR's escalation stands forever", String(call));

  // And that the set is actually filled, not merely declared and passed empty.
  check(/waiting\.add\(pr\)/.test(src) && /ACTIONS\.WAIT/.test(src),
    "and the tick adds a PR to it when its decision is WAIT");
}

// ── a PR that is over ────────────────────────────────────────────────────────
//
// The guard above refuses to retire an escalation for a PR this tick did not
// look at. A MERGED pull request leaves the open list, so it is never looked at
// again -- and its escalation could therefore never retire. Measured on nextly
// #1127: it merged, and "unclassified verdict BLOCK: mergeable blocked" stayed in
// NEEDS YOU with no way out.
//
// A surface whose target state is empty, filling with finished work, stops being
// read. That is the same muting the repeat-push guard exists to prevent, arriving
// from the other direction.
{
  announceable(db, m({ "#1127: mergeable blocked": 1 }), { covered: new Set([1127]), complete: true });

  // Control: the fixture must be able to exhibit the defect. The PR is absent
  // from the open set, so without `finished` nothing can ever clear it.
  const stuck = announceable(db, m({}), { covered: new Set([308, 834]), complete: true });
  check(stuck.cleared.length === 0,
    "control: a PR missing from the open set cannot retire on absence alone", JSON.stringify(stuck));

  const done = announceable(db, m({}),
    { covered: new Set([308, 834]), finished: new Set([1127]), complete: true });
  check(done.cleared.length === 1 && done.cleared[0].startsWith("#1127"),
    "but GitHub saying it is merged or closed does retire it", JSON.stringify(done));

  // Being finished outranks being in flight: a PR cannot be both, and if the two
  // ever disagree the positive fact about the subject is the truthful one.
  announceable(db, m({ "#1200: something": 1 }), { covered: new Set([1200]), complete: true });
  const both = announceable(db, m({}),
    { covered: new Set(), waiting: new Set([1200]), finished: new Set([1200]), complete: true });
  check(both.cleared.length === 1, "merged outranks waiting", JSON.stringify(both));
}

db.close();
  db = open(path);
  const r = announceable(db, m({ "#925: the branch conflicts with its base": 4 }));
  check(r.fresh.length === 0,
    "a restart does not re-announce what is already standing", JSON.stringify(r));
}

// Silence about a resolved problem is its own failure: an operator who is never
// told a thing cleared cannot tell "fixed" from "reeve stopped looking".
{
  const r = announceable(db, m({}));
  check(r.cleared.length === 1 && r.cleared[0].startsWith("#925"),
    "a condition that goes away is announced as cleared", JSON.stringify(r));
}

// And having cleared, the same cause returning is news again.
{
  const r = announceable(db, m({ "#925: the branch conflicts with its base": 1 }));
  check(r.fresh.length === 1, "the same cause recurring after clearing announces again", JSON.stringify(r));
}

// Two distinct causes must be tracked independently, not collapsed.
{
  announceable(db, m({ "#925: a": 1, "#308: b": 1 }));
  const r = announceable(db, m({ "#925: a": 1, "#308: b": 1, "#77: c": 1 }));
  check(r.fresh.length === 1 && r.fresh[0].why === "#77: c",
    "only the newly-arrived cause announces", JSON.stringify(r));
}


// A cause absent from THIS tick is not a cause that went away. When a tick cannot
// evaluate a PR -- a network blip, a rate limit, an early `continue` -- its
// escalation simply is not in the map, and clearing on that absence announces
// "resolved" for a problem nobody touched. Absence is not success here either.
{
  announceable(db, m({ "#500: a": 1, "#501: b": 1 }), { covered: new Set([500, 501]), complete: true });
  // A tick that only managed to look at 500.
  const r = announceable(db, m({ "#500: a": 1 }), { covered: new Set([500]), complete: false });
  check(r.cleared.length === 0,
    "a PR the tick never evaluated is NOT announced as cleared", JSON.stringify(r.cleared));
  // And when it is genuinely looked at and gone, it clears.
  const r2 = announceable(db, m({ "#500: a": 1 }), { covered: new Set([500, 501]), complete: true });
  check(r2.cleared.length === 1 && r2.cleared[0].startsWith("#501"),
    "but once it IS evaluated and absent, it clears", JSON.stringify(r2.cleared));
}
{
  // A shared cause names no PR, so only a tick that completed can retire it.
  announceable(db, m({ "the base branch is red": 4 }), { covered: new Set([1]), complete: true });
  const partial = announceable(db, m({}), { covered: new Set(), complete: false });
  check(partial.cleared.length === 0,
    "a shared cause survives an incomplete tick", JSON.stringify(partial.cleared));
  const done = announceable(db, m({}), { covered: new Set([1]), complete: true });
  check(done.cleared.length === 1, "and retires on a complete one", JSON.stringify(done.cleared));
}

// ── WAIT is not "resolved" ────────────────────────────────────────────────────
//
// Measured on nextly #834. Its decisions ran ESCALATE, then seven consecutive
// ticks of WAIT while CI was in flight, then ESCALATE again. A waiting tick
// produces no escalation, so the standing cause was retired and re-announced --
// twice, four and twenty-five minutes apart, with the reason string identical
// every time. Nothing about the condition had changed: a review thread was still
// unresolved and a human was still needed.
//
// Two phone pushes for one unchanged condition is how a channel earns being
// muted, and a muted channel is worse than no channel at all.
{
  announceable(db, m({ "#834: 1 of 1 thread(s) unresolved": 1 }), { covered: new Set([834]), complete: true });

  // Control: the fixture must be able to exhibit the defect. Without `waiting`,
  // this very call is what cleared it in production.
  const control = announceable(db, m({}), { covered: new Set([834]), complete: true });
  check(control.cleared.length === 1, "control: a covered PR with no escalation this tick does clear",
    JSON.stringify(control));

  // Put it back, then take the same tick with the PR waiting rather than settled.
  announceable(db, m({ "#834: 1 of 1 thread(s) unresolved": 1 }), { covered: new Set([834]), complete: true });
  const waited = announceable(db, m({}),
    { covered: new Set([834]), waiting: new Set([834]), complete: true });

  check(waited.cleared.length === 0,
    "a PR whose decision was WAIT does not retire its escalation", JSON.stringify(waited));
  check(waited.fresh.length === 0,
    "and it is not re-announced either -- it never stopped standing", JSON.stringify(waited));

  // Once it settles and the cause is genuinely gone, it clears exactly once.
  const settled = announceable(db, m({}), { covered: new Set([834]), waiting: new Set(), complete: true });
  check(settled.cleared.length === 1, "and clears once the tick actually settles it",
    JSON.stringify(settled));

  // A waiting PR must not block an UNRELATED standing cause from retiring.
  announceable(db, m({ "#900: something else": 1 }), { covered: new Set([900]), complete: true });
  const other = announceable(db, m({}),
    { covered: new Set([900, 834]), waiting: new Set([834]), complete: true });
  check(other.cleared.length === 1 && other.cleared[0].startsWith("#900"),
    "one PR waiting does not hold another PR's escalation open", JSON.stringify(other));
}

db.close();
rmSync(dir, { recursive: true, force: true });

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
