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
import { open, tx, checkpoint, heartbeat, reap, resume, LEASE_SECONDS } from "../src/db/ops.mjs";
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
  // The REASON, not just the refusal. `reap` leaves the old `lease_expires_at` in
  // place, so reading the timestamp alone reports "lease-expired" -- which tells a
  // caller its lease merely timed out, when in fact ownership was taken and the
  // task handed to another run. Those are different facts and a caller may
  // reasonably act on them differently. `heartbeat` has always distinguished them;
  // this did not until it was pointed out, and my first version of this test
  // asserted only that it refused, which is why the gap survived the fix.
  check(r?.reason === "lease-lost",
    "and says ownership was LOST, not merely expired", JSON.stringify(r));
  const ev = db.prepare(`SELECT payload FROM event WHERE op='run.checkpoint.refused' ORDER BY seq DESC LIMIT 1`).get();
  check(JSON.parse(ev.payload).reason === "lease-lost",
    "and the audit record says the same thing the caller was told", ev.payload);
  check(steps("reaped") === 0, "and leaves no record of progress it did not make", String(steps("reaped")));
}

// --- a REFUSED checkpoint leaves no progress behind ---------------------------
{
  // The half a restore-the-lease fix missed. The claiming UPDATE also sets `step`,
  // json-patches `cursor` and refreshes `heartbeat_at`, so a refused checkpoint
  // could still leave progress recorded -- and `resume` would then read a step the
  // run never successfully recorded and carry on from work that was never done.
  // Putting `lease_expires_at` back covered one field of four, and `cursor` is not
  // trivially reversible once patched, which is the tell that not-writing was the
  // right shape and restoring was not.
  makeRun("refused", now() + 300);
  checkpoint(db, { runId: "refused", step: "first", seq: 1, state: { a: 1 } });
  const before = runRow("refused");
  const beforeMore = db.prepare(`SELECT cursor, heartbeat_at FROM run WHERE id='refused'`).get();
  check(before.step === "first", "control: a live run recorded its first step", JSON.stringify(before));

  tx(db, () => db.prepare(`INSERT INTO task_exec(task_id,cancel_requested) VALUES('task-refused',1)
                           ON CONFLICT(task_id) DO UPDATE SET cancel_requested=1`).run());
  const r = checkpoint(db, { runId: "refused", step: "second", seq: 2, state: { b: 2 } });
  check(r?.ok === false && r.reason === "cancelled", "a cancelled run's checkpoint is refused", JSON.stringify(r));

  const after = runRow("refused");
  const afterMore = db.prepare(`SELECT cursor, heartbeat_at FROM run WHERE id='refused'`).get();
  check(after.step === "first", "and the run's step did NOT move to the refused one", after.step);
  check(afterMore.cursor === beforeMore.cursor, "nor was the cursor patched with its state", afterMore.cursor);
  check(after.lease_expires_at === before.lease_expires_at, "nor was the lease renewed",
    `${before.lease_expires_at} -> ${after.lease_expires_at}`);
  check(afterMore.heartbeat_at === beforeMore.heartbeat_at, "nor the heartbeat refreshed",
    `${beforeMore.heartbeat_at} -> ${afterMore.heartbeat_at}`);
  check(steps("refused") === 1, "and no checkpoint row was written for it", String(steps("refused")));
  // The property that matters downstream, asserted rather than inferred.
  const res = resume(db, "refused");
  check(!res.done.includes("second"), "so resume never sees a step the run did not record", JSON.stringify(res.done));
}

// --- a REFUSED checkpoint writes nothing at all ------------------------------
{
  // Not just "no checkpoint row". The claiming UPDATE also set `step`,
  // json-patched `cursor` and refreshed `heartbeat_at`, so an earlier version
  // refused the call and left progress behind -- and `resume` would then read a
  // step the run never successfully recorded and carry on from work a cancelled
  // worker did not do. Putting `lease_expires_at` back covered one field of four,
  // and `cursor` is not trivially reversible once patched, which is the tell that
  // restoring was the wrong shape and not-writing was the right one.
  makeRun("frozen", now() + 300);
  const before = db.prepare(`SELECT status, step, cursor, heartbeat_at, lease_expires_at FROM run WHERE id='frozen'`).get();
  tx(db, () => db.prepare(`INSERT INTO task_exec(task_id,cancel_requested) VALUES('task-frozen',1)
                           ON CONFLICT(task_id) DO UPDATE SET cancel_requested=1`).run());

  const r = checkpoint(db, { runId: "frozen", step: "publish", seq: 1, state: { pushed: true } });
  check(r?.ok === false && r.reason === "cancelled", "a cancelled run's checkpoint is refused", JSON.stringify(r));

  const after = db.prepare(`SELECT status, step, cursor, heartbeat_at, lease_expires_at FROM run WHERE id='frozen'`).get();
  for (const field of ["step", "cursor", "heartbeat_at", "lease_expires_at", "status"])
    check(after[field] === before[field], `and ${field} is exactly as it was`,
      `${JSON.stringify(before[field])} -> ${JSON.stringify(after[field])}`);
  check(steps("frozen") === 0, "and no checkpoint row was written", String(steps("frozen")));

  // Control: the fixture really could have moved. The same call on the same run,
  // with the cancellation lifted, changes every one of those fields -- so the
  // assertions above are about the refusal and not about a run that was inert.
  tx(db, () => db.prepare(`UPDATE task_exec SET cancel_requested=0 WHERE task_id='task-frozen'`).run());
  const ok2 = checkpoint(db, { runId: "frozen", step: "publish", seq: 1, state: { pushed: true } });
  const moved = db.prepare(`SELECT step, cursor FROM run WHERE id='frozen'`).get();
  check(ok2?.ok === true && moved.step === "publish" && moved.cursor !== before.cursor,
    "control: with the cancellation lifted the same call DOES move them", JSON.stringify(moved));
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
