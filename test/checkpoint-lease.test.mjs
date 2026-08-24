// A checkpoint is progress by a holder. If the hold has lapsed, it is not progress
// — it is a lost run writing into a record another run may already own.
//
// `heartbeat` refuses to renew a lapsed lease and says why: a daemon that stalled
// past its deadline while its worker kept running has already lost the claim, and
// reviving it would let that worker finish and publish under a lease that had
// lapsed. `checkpoint` then did exactly that revival, with no status check and no
// expiry check, three functions below the comment forbidding it.
//
// Measured before the fix: a run 60 seconds past its deadline was refused by
// `heartbeat`, checkpointed once, and `heartbeat` reported it alive again.
import { open, tx, checkpoint, heartbeat, reap, LEASE_SECONDS } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-cp-"));
const db = open(join(dir, "s.db"));
const now = () => Math.floor(Date.now() / 1000);
const runRow = id => db.prepare(`SELECT status, lease_expires_at, step FROM run WHERE id=?`).get(id);
const steps = id => db.prepare(`SELECT count(*) n FROM checkpoint WHERE run_id=?`).get(id).n;

const makeRun = (id, expiresAt, status = "running") => tx(db, () => {
  db.prepare(`INSERT OR IGNORE INTO node(id,kind,title,status,created_at,updated_at,version)
              VALUES(?,'task','t','running',unixepoch(),unixepoch(),1)`).run(`task-${id}`);
  db.prepare(`INSERT INTO run(id,task_id,profile,lane,status,attempt,lease_expires_at,heartbeat_at,
                              owner_pid,owner_boot,owner_host,step,cursor,started_at)
              VALUES(?,?,'p','fixer',?,1,?,unixepoch(),1,'b','h','','{}',unixepoch())`)
    .run(id, `task-${id}`, status, expiresAt);
});

// --- a live run checkpoints normally ------------------------------------------
{
  makeRun("live", now() + 300);
  const r = checkpoint(db, { runId: "live", step: "branch", seq: 1, state: { branch: "fix/x" } });
  check(r?.ok === true, "a run that holds its lease checkpoints", JSON.stringify(r));
  check(steps("live") === 1, "and the step is recorded", String(steps("live")));
  check(runRow("live").step === "branch", "and the run's cursor moves with it", JSON.stringify(runRow("live")));
  check(heartbeat(db, { runId: "live" }).alive === true, "control: and it is still alive", "");
}

// --- the defect: a lapsed lease must NOT be revived ---------------------------
{
  makeRun("lapsed", now() - 60);
  const hb1 = heartbeat(db, { runId: "lapsed" });
  check(hb1.alive === false && hb1.reason === "lease-expired",
    "control: heartbeat refuses a lapsed lease, as it documents", JSON.stringify(hb1));

  const before = runRow("lapsed").lease_expires_at;
  const r = checkpoint(db, { runId: "lapsed", step: "push", seq: 1, state: { head: "abc" } });
  check(r?.ok === false && r.reason === "lease-expired", "checkpoint refuses it too", JSON.stringify(r));
  check(runRow("lapsed").lease_expires_at === before,
    "and does NOT push the deadline forward", `${before} -> ${runRow("lapsed").lease_expires_at}`);
  check(heartbeat(db, { runId: "lapsed" }).alive === false,
    "so heartbeat still refuses afterwards — the guard was not walked around", "");
  check(steps("lapsed") === 0, "and nothing was written for a run that had lost its claim",
    String(steps("lapsed")));
  check(runRow("lapsed").step === "", "nor was the run's cursor moved", JSON.stringify(runRow("lapsed")));
}

// --- a run REAPED and handed on cannot be written into ------------------------
{
  makeRun("reaped", now() - 60);
  const out = reap(db, { isAlive: () => false });
  check(out.some(o => o.run === "reaped" && o.action === "reaped"),
    "control: an expired run with a dead owner is reaped", JSON.stringify(out));
  check(runRow("reaped").status === "abandoned", "control: and marked abandoned", runRow("reaped").status);
  const r = checkpoint(db, { runId: "reaped", step: "publish", seq: 1, state: {} });
  check(r?.ok === false, "an abandoned run cannot checkpoint", JSON.stringify(r));
  check(steps("reaped") === 0, "and leaves no record of progress it did not make", String(steps("reaped")));
}

// --- a run that never existed -------------------------------------------------
{
  const r = checkpoint(db, { runId: "ghost", step: "x", seq: 1, state: {} });
  check(r?.ok === false && r.reason === "no-such-run", "an unknown run is refused by name",
    JSON.stringify(r));
}

// --- the refusal is recorded, so a lost run is visible afterwards -------------
{
  const n = db.prepare(`SELECT count(*) n FROM event WHERE op='run.checkpoint.refused'`).get().n;
  check(n >= 3, "every refusal is emitted rather than being silent", String(n));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
