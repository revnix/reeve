// A heartbeat after the lease deadline must not revive the lease.
//
// If the daemon's event loop stalls past LEASE_SECONDS while its detached
// worker keeps running, the lease has lapsed; the next heartbeat used to
// update the row regardless and answer alive, so the worker finished and
// published under a claim that had already expired.
import { open, startRun, heartbeat } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-lease-"));
const db = open(join(dir, "l.db"));

const run = startRun(db, { nwo: "o/r", pr: 1, action: "FIX_CI", head: "a".repeat(40) });
check(heartbeat(db, { runId: run.runId }).alive === true, "control: a fresh lease heartbeats alive");

db.prepare("UPDATE run SET lease_expires_at = unixepoch() - 5 WHERE id = ?").run(run.runId);
const late = heartbeat(db, { runId: run.runId });
check(late.alive === false && /expired/.test(late.reason ?? ""), "a heartbeat after the deadline is refused, with the reason", JSON.stringify(late));
const row = db.prepare("SELECT lease_expires_at FROM run WHERE id = ?").get(run.runId);
check(row.lease_expires_at < Math.floor(Date.now() / 1000), "and the lapsed lease was not revived", JSON.stringify(row));

db.close(); rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
