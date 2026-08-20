// Two ways reeve's own reporting told a comforting story.
//
// readState() marked a PR stale relative to the NEWEST STORED DECISION, not to
// the clock. If the daemon stopped entirely, every row stayed "fresh" forever,
// because each was compared against another equally old row. The screen a person
// checks to see whether anything is wrong would look calm precisely when the
// thing that watches had died.
//
// And nothing recorded that a tick had happened at all, so there was no way to
// ask "when did this last run?" -- the question that distinguishes "quiet" from
// "stopped".
import { open } from "../src/db/ops.mjs";
import { readState, noteTick } from "../src/status.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-fresh-"));
const db = open(join(dir, "f.db"));
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NOW = 1_800_000_000;
const decide = (pr, at) => db.prepare(
  `INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)`
).run(at, "daemon", "pr.decided", `pr:${pr}`, JSON.stringify({ state: "BLOCK", action: "WAIT", why: "x", head: "a" }));

// Two decisions, both ancient, ten minutes apart. Compared against each other
// they look current; compared against the clock they are hours old.
decide(1, NOW - 7200);
decide(2, NOW - 6600);

{
  const s = readState(db, { now: NOW });
  const stale = s.prs.filter(p => p.stale).length;
  check(stale === 2, "decisions hours old are stale, however recent they are relative to each other",
    JSON.stringify(s.prs.map(p => ({ id: p.id, stale: p.stale }))));
}
{
  decide(3, NOW - 30);
  const s = readState(db, { now: NOW });
  const fresh = s.prs.filter(p => !p.stale).map(p => p.id);
  check(fresh.length === 1 && fresh[0] === "pr:3", "and a decision from seconds ago is not", JSON.stringify(fresh));
}

// --- the daemon's own liveness ----------------------------------------------
{
  const s = readState(db, { now: NOW });
  check(s.daemon?.lastTickAt == null, "control: with no tick recorded, liveness is unknown, not healthy",
    JSON.stringify(s.daemon));
  check(s.daemon?.alive === null, "and it says unknown rather than guessing", JSON.stringify(s.daemon));
}
{
  noteTick(db, NOW - 60);
  const s = readState(db, { now: NOW });
  check(s.daemon?.lastTickAt === NOW - 60, "a recorded tick is readable", JSON.stringify(s.daemon));
  check(s.daemon?.alive === true, "and a recent one means alive", JSON.stringify(s.daemon));
}
{
  // Liveness reads the MOST RECENT tick, so an old one must not be able to make a
  // live daemon look dead. Writing NOW-3600 alongside NOW-60 correctly changes
  // nothing -- the silence has to be real, so the recent tick is cleared first.
  const before = readState(db, { now: NOW });
  noteTick(db, NOW - 3600);
  check(readState(db, { now: NOW }).daemon.alive === true,
    "an older tick cannot make a live daemon look dead", JSON.stringify(before.daemon));
  db.prepare("DELETE FROM event WHERE op='daemon.tick' AND at > ?").run(NOW - 3600);
  const s = readState(db, { now: NOW });
  check(s.daemon?.alive === false,
    "an hour of silence is reported as NOT alive, which is the whole point", JSON.stringify(s.daemon));
  check(typeof s.daemon?.why === "string" && s.daemon.why.length > 0,
    "with a reason a person can act on", JSON.stringify(s.daemon?.why));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
