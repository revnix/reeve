// The store implements claim, heartbeat, reap, checkpoint and an outbox, and the
// daemon imported none of them. It spawned a worker directly, wrote a best-effort
// event, and swallowed any failure to record. The live nextly store had 1,230
// events and ZERO rows in run, checkpoint, outbox and inbox.
//
// The cost was already visible in the service log: the same fix was dispatched at
// 15:02:46 and again at 15:12:02, and only the second recorded a completion. With
// no durable run there is nothing to say "this work is already in flight", so a
// restart re-dispatches it.
//
// The schema already carried the right invariant -- at most one live run per task
// -- so a run bound to the pull request is enough to make duplicate dispatch
// impossible rather than merely unlikely.
import { open, startRun, notePid, finishRun, heartbeat, liveRunFor } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-run-"));
const path = join(dir, "r.db");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const START = { nwo: "o/r", pr: 925, action: "FIX_CI", head: "a".repeat(40), lane: "ci-fixer" };

let db = open(path);

// --- a run must exist before any worker may start ---------------------------
let first;
{
  first = startRun(db, START);
  check(first.ok && Boolean(first.runId), "control: a run starts and returns an id", JSON.stringify(first));
  const row = db.prepare("SELECT status, task_id, attempt FROM run WHERE id=?").get(first.runId);
  check(row?.status === "leased", "it is leased", JSON.stringify(row));
  check(row?.task_id === "pr:925", "and it is bound to the pull request, not to a lane", JSON.stringify(row));
}

// --- THE invariant: duplicate dispatch is impossible, not unlikely ----------
{
  const second = startRun(db, START);
  check(second.ok === false, "a second run for the same PR is refused while the first is live",
    JSON.stringify(second));
  check(/live|already/i.test(second.why ?? ""), "and it says why", JSON.stringify(second.why));
}
{
  const otherPr = startRun(db, { ...START, pr: 926 });
  check(otherPr.ok, "a different PR is unaffected", JSON.stringify(otherPr));
  finishRun(db, { runId: otherPr.runId, outcome: "ok" });
}

// --- the identity of the process, persisted before it can do anything -------
{
  notePid(db, { runId: first.runId, pid: 4242, boot: "Thu Aug 20 12:00:00 2026" });
  const row = db.prepare("SELECT owner_pid, owner_boot, status FROM run WHERE id=?").get(first.runId);
  check(row?.owner_pid === 4242, "the worker's pid is recorded", JSON.stringify(row));
  // A pid alone is not identity: pids are reused, and were forced to wrap in 192
  // seconds on this machine. The start time is what distinguishes them.
  check(row?.owner_boot === "Thu Aug 20 12:00:00 2026", "with its start time, because pids are reused");
  check(row?.status === "running", "and noting the pid moves the run from leased to running");
}

// --- it survives the restart that KeepAlive makes routine -------------------
{
  db.close(); db = open(path);
  const live = liveRunFor(db, "o/r", 925);
  check(live?.id === first.runId, "after a restart the live run is still found", JSON.stringify(live));
  const again = startRun(db, START);
  check(again.ok === false,
    "so a restarted daemon does not re-dispatch work already in flight — the duplicate seen in the log",
    JSON.stringify(again));
}

// --- heartbeat, and release --------------------------------------------------
{
  const before = db.prepare("SELECT lease_expires_at FROM run WHERE id=?").get(first.runId).lease_expires_at;
  const ok = heartbeat(db, { runId: first.runId });
  const after = db.prepare("SELECT lease_expires_at FROM run WHERE id=?").get(first.runId).lease_expires_at;
  check(ok !== false, "a live run can heartbeat", String(ok));
  check(after >= before, "and the lease does not go backwards", `${before} -> ${after}`);
}
{
  finishRun(db, { runId: first.runId, outcome: "ok", ms: 1000, cost: 1.5 });
  const row = db.prepare("SELECT status, ended_at FROM run WHERE id=?").get(first.runId);
  check(row?.status === "succeeded", "finishing marks it succeeded", JSON.stringify(row));
  check(row?.ended_at > 0, "and stamps an end time");
  check(liveRunFor(db, "o/r", 925) === null, "and it is no longer live");
}
{
  const after = startRun(db, START);
  check(after.ok, "once finished, the same PR can be worked again", JSON.stringify(after));
  check(after.attempt === 2, "and the attempt count carries forward", JSON.stringify(after.attempt));
  finishRun(db, { runId: after.runId, outcome: "failed", why: "worker died" });
  const row = db.prepare("SELECT status, error FROM run WHERE id=?").get(after.runId);
  check(row?.status === "failed" && /worker died/.test(row.error ?? ""),
    "a failure records its reason rather than vanishing", JSON.stringify(row));
}

// --- the event trail --------------------------------------------------------
{
  const ops = db.prepare("SELECT op FROM event WHERE run_id IS NOT NULL ORDER BY seq").all().map(r => r.op);
  check(ops.includes("run.start") && ops.includes("run.finish"),
    "starting and finishing are both in the event log, attributed to the run", JSON.stringify(ops));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
