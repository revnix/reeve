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
import { mkdtempSync, rmSync } from "node:fs";
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

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
