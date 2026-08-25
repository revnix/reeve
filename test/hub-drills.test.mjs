// Crash and corruption, as drills rather than as unit tests.
//
// The crash drill kills a real child process mid-transition. That matters:
// SQLite's atomicity is the thing being relied on, and a same-process test with
// a mocked failure proves only that the MOCK rolled back.
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { applyTransition } from "../src/build/transition.mjs";
import { enqueueEffect, leaseEffect, settleEffect, recoverEffects } from "../src/build/outbox.mjs";
import { snapshotAll, latestSnapshot } from "../src/backup.mjs";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { openSync, writeSync, closeSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { fail++; if (detail !== undefined) console.log(`        ${detail}`); }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-drills-dir-"));
const allOn = {
  "builder.capabilities.observe": true, "builder.capabilities.draftSpec": true,
  "builder.capabilities.implementLocal": true, "builder.capabilities.publishPr": true,
  "builder.capabilities.mergeBuilderPr": true,
};
const seed = (db, { id, phase, generation = 1, events = 12 }) => {
  db.prepare(
    `INSERT INTO task(id, project, repo_id, nwo_snapshot, title, phase, generation,
                      source_kind, source_key, repo_path, profile_path, profile_hash,
                      default_branch, visibility, registry_version, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())`)
    .run(id, "p", 1, "o/r", "t", phase, generation, "founder", `k:${id}`,
         "/repo", "/profile.json", "hash", "main", "private", 1);
  for (let i = 0; i < events; i++)
    db.prepare(
      `INSERT INTO phase_event(task, at, op, from_phase, to_phase, from_generation, to_generation, detail)
       VALUES(?, unixepoch(), 'phase.advanced', ?, ?, ?, ?, '{}')`)
      .run(id, phase, phase, generation, generation);
};

// This file's OWN fixed lease clock. Task 16's `NOW` belongs to
// `test/hub-outbox.test.mjs`, a different module whose bindings are not visible
// here -- the recovery drill leases an effect, so reading that name would throw
// at its first line and never exercise recovery at all. Same value deliberately:
// the two files assert the same not-before arithmetic, and two clocks that
// drifted would make one of them wrong for a reason nobody would look for here.
const NOW = 1_800_000_000;

// The child imports from the checkout, so the paths in its generated source must
// be ABSOLUTE -- a relative specifier resolves from the temp directory the
// worker is written into, where there is no src/.
const SRC = join(process.cwd(), "src");
// `home` and `root` are this file's own, not `dir`: the corruption drill takes a
// snapshot, and snapshotAll wants a machine root and a backup root.
const home = mkdtempSync(join(tmpdir(), "reeve-drills-"));
const root = join(home, "backups");
mkdirSync(join(home, "state"), { recursive: true });
// ── a transition interrupted by SIGKILL is all or nothing ────────────────────
{
  const p = join(dir, "crash.db");
  const db0 = openHub(p);
  // 500 tasks, all identical, so the kill can land inside any one of their
  // transactions and the invariant is checked over every one of them.
  const seedTasks = (db, count, phase) => hubTx(db, () => {
    const ins = db.prepare(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,
                              source_kind,source_key,repo_path,profile_path,profile_hash,
                              default_branch,visibility,registry_version,created_at,updated_at)
                            VALUES(?,'p',1,'o/r','t',?,1,'founder',?,'/p','/f','h','main','private',1,
                                   unixepoch(),unixepoch())`);
    for (let i = 0; i < count; i++) ins.run(`bt:${i}`, phase, `k:${i}`);
  });

  // The child must be killed WHILE a transaction is open, which a SIGSTOP before
  // the call cannot arrange: stopping the process before applyTransition runs
  // means the transaction never begins, the parent always observes the untouched
  // branch, and the drill passes even against an applyTransition that writes its
  // event outside the transaction entirely.
  //
  // So the child transitions many tasks in a tight loop and the parent kills it
  // only after it has watched real progress in the database. The kill therefore
  // lands inside SOME transaction, and the assertion is the invariant that must
  // hold for EVERY task whichever one it landed in: the projection and the log
  // agree. A torn write shows up as a task whose phase moved with no event, or
  // an event with no phase change.
  const worker = join(dir, "crash-worker.mjs");
  writeFileSync(worker, `
import { openHub } from "${SRC}/build/hubdb.mjs";
import { applyTransition } from "${SRC}/build/transition.mjs";
import { writeSync, readSync } from "node:fs";
import { constants } from "node:sqlite";
const db = openHub(process.argv[2]);
// THE HANDSHAKE, WRITTEN. An earlier revision described it in a comment beside
// this template and generated a worker that never signalled, so fd 3 never
// carried a byte, the race always settled on the child's exit, and the drill
// reported failure whatever the implementation did.
//
// The seam is the AUTHORIZER, because it is the only callback that fires at the
// right instant without changing production code. SQLite calls it while
// applyTransition prepares its INSERT INTO phase_event -- which happens inside
// hubTx's BEGIN IMMEDIATE and AFTER the projection UPDATE has already run. That
// is exactly the window the drill needs: a torn implementation has written the
// phase and not yet the event. Signalling from isAlive would be too early (it
// runs before the UPDATE) and wrapping the call in our own hubTx is impossible
// (nested BEGIN IMMEDIATE throws in node:sqlite).
//
// The child announces itself on fd 3 and then BLOCKS on a read from fd 4, which
// the parent never writes. It therefore cannot leave the transaction whatever
// the scheduler does, and the kill lands inside it by construction rather than
// by timing. readSync on a pipe with no writer throws EAGAIN on some platforms,
// hence the catch; a child that falls through simply continues.
let armed = false, signalled = false;
db.setAuthorizer((op, arg1) => {
  if (armed && !signalled && op === constants.SQLITE_INSERT && arg1 === "phase_event") {
    signalled = true;
    writeSync(3, "x");
    try { readSync(4, Buffer.alloc(1), 0, 1, null); } catch {}
  }
  return constants.SQLITE_OK;
});
for (let i = 0; i < 500; i++) {
  // Let a couple of hundred transitions COMMIT before arming, so the kill lands
  // MID-RUN. Signalling on the first iteration would leave zero committed
  // events and the parent's "the kill really did interrupt the run" control
  // would fail against a perfectly correct implementation.
  armed = i >= 250;
  applyTransition(db, { taskId: "bt:" + i, expectedPhase: "RESEARCH", expectedGeneration: 1,
    evidence: { kind: "phase.succeeded", phase: "RESEARCH" }, artifactSha: "s" + i, op: "phase.advanced" });
}
`);
  seedTasks(db0, 500, "RESEARCH");             // bt:0 .. bt:499, all at generation 1
  db0.close();
  // fd 3 and fd 4 are the handshake. The child writes one byte on fd 3 after its
  // BEGIN IMMEDIATE and before its COMMIT, then BLOCKS on a read from fd 4 -- so
  // between those two points it is provably inside the transaction and cannot
  // leave it, whatever the scheduler does. The parent kills on that byte.
  //
  // Killing on the SQLITE_BUSY probe alone is not enough: between the probe
  // observing the lock and `kid.kill` running there is a promise handoff, and
  // the child can commit inside it. The kill then lands between transactions,
  // every task is intact for the ordinary reason, and the drill reports
  // atomicity green against an implementation whose writes tear.
  const kid = spawn(process.execPath, [worker, p], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const insideTxSignal = new Promise((res) => kid.stdio[3].once("data", () => res("inside")));
  // IMMEDIATELY after spawn, before the probe is opened. 500 fast transactions
  // can finish while the setup below runs, and EventEmitter does not replay a
  // missed event -- so a listener attached later never fires: the race falls
  // through to `timeout`, `kid.kill` targets an exited process, and `await exit`
  // hangs the suite forever. A hanging test is worse than a failing one.
  const exit = new Promise((res) => kid.on("exit", () => res("exited")));
  // Wait for OBSERVED progress rather than a fixed delay: a sleep long enough to
  // be safe on a fast machine is long enough to miss the window on a slow one,
  // and a sleep that lands after the loop finished is the SIGSTOP bug again.
  // Committed rows prove the child finished a transaction, NOT that it is inside
  // one -- so killing after seeing them can land between iterations, and the
  // drill would still pass against an implementation that writes the projection
  // outside the transaction.
  //
  // SQLite answers the real question directly. While the child holds an open
  // write transaction the database is write-locked, so a BEGIN IMMEDIATE from
  // here fails with SQLITE_BUSY. busy_timeout is set to 0 so it fails instantly
  // instead of waiting the child out. A refusal is positive evidence that a
  // transaction is open RIGHT NOW; that is the moment to kill.
  const probe = new DatabaseSync(p);
  probe.exec("PRAGMA busy_timeout = 0");
  const insideTx = async () => {
    for (let i = 0; i < 500; i++) {
      try { probe.exec("BEGIN IMMEDIATE"); probe.exec("ROLLBACK"); }
      catch { return true; }                   // locked out: the child is mid-transaction
      await new Promise(r => setTimeout(r, 2));
    }
    return false;
  };
  // Watch for the child EXITING as well: 500 fast transactions can complete
  // before the first probe, and then the loop spins to its limit and reports a
  // missed window as a failure of the code rather than of the timing. A child
  // that finished cleanly means the drill has to be re-run with more work, not
  // that atomicity is broken.
  // RACE the probe against the child's exit rather than polling a flag. A
  // boolean checked after insideTx() returns does not stop insideTx() from
  // spinning its full 500 iterations when the child finished early, and the
  // kill then targets a dead pid. Whichever settles first decides.
  // BOTH: the child's own signal says it is inside a transaction, and the
  // SQLITE_BUSY probe is the CONTROL that the lock really is held when the byte
  // arrives -- so the handshake cannot pass on a child that signals without
  // having opened anything.
  const caught = await Promise.race([insideTxSignal, exit]);
  // `"inside"` is what `insideTxSignal` resolves to and `"exited"` is what the
  // child's exit resolves to; those are the only two outcomes this race has. The
  // previous revision asserted `caught === "locked"`, a value nothing here can
  // ever produce, so the drill reported failure against every implementation --
  // including a correct one -- and the message it printed blamed the timing.
  check(caught === "inside",
    "the child signalled from INSIDE an open write transaction",
    caught === "exited"
      ? "the worker finished before it signalled: lower the arming index or raise the loop count and re-run"
      : `the race settled on ${caught}`);
  // CONTROL, and it is what makes the signal mean anything at all: a child could
  // write fd 3 from anywhere. SQLITE_BUSY on BEGIN IMMEDIATE from this process
  // is INDEPENDENT evidence that the write lock really is held at this instant,
  // so the handshake cannot pass on a child that signals without having opened
  // anything.
  if (caught === "inside") {
    const locked = await insideTx();
    check(locked, "control: the write lock IS held when the child says it is inside a transaction",
      String(locked));
  }
  // (A second, duplicate `check(caught, ...)` used to sit here. It was vacuous:
  // every outcome of the race is a non-empty string, so it passed on "exited"
  // and "timeout" as readily as on "locked".)

  // Kill only if the child is STILL RUNNING, and reuse the one exit promise.
  // `once(kid, "exit")` installs a fresh listener, and EventEmitter does not
  // replay past events -- so when the race was won by `exit`, the child is
  // already gone, the new listener never fires, and the whole suite HANGS
  // rather than reporting red. A hanging test is worse than a failing one: CI
  // reports a timeout with no assertion to read.
  if (caught !== "exited") {
    // KILL WHILE THE TRANSACTION IS OPEN, not merely after observing that one was.
    // `SQLITE_BUSY` proves the child held the write lock at the moment the probe
    // failed; between that observation and this line there is a promise handoff,
    // and the child can have committed in it. The kill then lands between
    // transactions, every task is intact for the ordinary reason, and the
    // `pe > 0 && pe < 500` control still passes -- so the drill reports atomicity
    // green against an implementation whose writes tear when interrupted.
    //
    // The child therefore holds the door open: after its BEGIN IMMEDIATE and
    // before its COMMIT it writes a byte to fd 3 and then blocks on a read from
    // fd 4, so it is provably inside the transaction and cannot leave it. The
    // parent kills on that byte. The pipes make the handshake, not the clock:
    //
    //     const kid = spawn(process.execPath, [worker, p],
    //                       { stdio: ["ignore","ignore","ignore","pipe","pipe"] });
    //     const inside = new Promise(res => kid.stdio[3].once("data", res));
    //     await Promise.race([inside, exit]);
    //
    // The SQLITE_BUSY probe stays as the CONTROL: it proves the lock really is
    // held when the byte arrives, so the handshake cannot pass on a child that
    // signals without having opened anything.
    kid.kill("SIGKILL");
    await exit;                       // already resolved if it has since exited
  }
  probe.close();

  const back = openHub(p);
  const torn = back.prepare(`
    SELECT t.id, t.phase, (SELECT count(*) FROM phase_event e WHERE e.task = t.id) AS events
    FROM task t
    WHERE (t.phase = 'DESIGN'   AND events = 0)      -- moved with no record
       OR (t.phase = 'RESEARCH' AND events > 0)`).all();
  check(torn.length === 0,
    "after SIGKILL every task's projection and log agree: each either moved with its event, or neither",
    torn.slice(0, 5).map(r => `${r.id} phase=${r.phase} events=${r.events}`).join("; "));
  const pe = back.prepare("SELECT count(*) c FROM phase_event").get().c;
  const he = back.prepare("SELECT count(*) c FROM hub_event WHERE kind='task.transitioned'").get().c;
  check(pe === he, "and hub_event agrees with phase_event, because they are written in one transaction",
    `phase_event=${pe} hub_event=${he}`);
  check(pe > 0 && pe < 500,
    "control: the kill really did interrupt the run, so this is a torn-write test and not a no-op",
    `${pe} of 500 transitions committed`);
  back.close();
}

// ── an inflight effect whose drainer died is recovered, not silently retried ──
{
  const db = openHub(join(dir, "rec.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "k", kind: "gh.pr.create", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${leased.id}`);

  // The important part: an expired inflight row goes to its RECONCILER, not
  // straight back to pending. Returning it to pending would perform the effect
  // a second time whenever the first one had actually landed.
  let asked = null;
  recoverEffects(db, { reconcile: (row) => { asked = row.kind; return { settled: true, ok: true, result: { pr: 7 } }; } });
  check(asked === "gh.pr.create", "an expired inflight row is handed to its reconciler", String(asked));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.id).status === "done",
    "and settled from external truth");

  const db2 = openHub(join(dir, "rec2.db")); seed(db2, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db2, () => enqueueEffect(db2, { idempotencyKey: "k", kind: "gh.pr.create", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const l2 = leaseEffect(db2, { worker: "w", capabilities: allOn });
  db2.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${l2.id}`);
  recoverEffects(db2, { reconcile: () => ({ settled: false }) });
  check(db2.prepare("SELECT status FROM outbox WHERE id=?").get(l2.id).status === "pending",
    "control: a reconciler that cannot decide returns the row to pending, so it is retried rather than lost");
}

// ── a corrupt hub refuses to open and points at the last good snapshot ───────
{
  // The DISCOVERABLE hub path, not the harness's `dir`. snapshotAll finds stores
  // through `everyStore(home)`, which looks for the hub under home/state; the
  // injected `open` only changed HOW a discovered path was opened and could not
  // add an unrelated file to the discovery set. So nothing was snapshotted,
  // `latestSnapshot` stayed null, and the fixture assertion failed while
  // reporting itself as a corruption-handling defect. Dropping the injection
  // also removes a seam that made the drill look wired when it was not.
  const p = join(home, "state", "hub.db");
  openHub(p).close();
  // A known-good snapshot FIRST. The refusal is required to name the newest
  // usable snapshot by path, and in an isolated test directory there is none --
  // so `latestSnapshot` returns null and the final assertion fails on fixture
  // setup while reporting itself as a corruption-handling defect.
  snapshotAll(home, root, { at: Math.floor(Date.now() / 1000) - 60 });
  check(latestSnapshot(root, "hub") !== null,
    "fixture: a usable snapshot exists for the refusal to name", String(latestSnapshot(root, "hub")));
  // Corrupt a page the database ACTUALLY USES, derived from the file rather than
  // hardcoded. Offset 8192 is page 3; it is a live page here only because
  // openHub creates 32 tables and their indexes (67 pages, measured 2026-08-23
  // in docs/measured/2026-08-23-sqlite-page-corruption.md). A fixture of two
  // pages or fewer takes that write past the end of the file, integrity_check
  // still answers `ok`, and every assertion below passes having corrupted
  // nothing -- which is the exact failure this drill exists to rule out.
  const geom = new DatabaseSync(p, { readOnly: true });
  const pageSize  = geom.prepare("PRAGMA page_size").get().page_size;
  const pageCount = geom.prepare("PRAGMA page_count").get().page_count;
  geom.close();
  const fd = openSync(p, "r+");
  writeSync(fd, Buffer.alloc(pageSize, 0x41), 0, pageSize, (pageCount - 1) * pageSize);
  closeSync(fd);

  // CONTROL, and the durable half: prove the file is really broken before
  // asserting that openHub says so. If the technique ever stops corrupting
  // anything, this goes red instead of letting the assertions below pass
  // vacuously.
  const probe = new DatabaseSync(p, { readOnly: true });
  let integrity = null;
  try { integrity = Object.values(probe.prepare("PRAGMA integrity_check").get())[0]; }
  catch (e) { integrity = `threw: ${e.message}`; }
  finally { probe.close(); }
  check(integrity !== "ok", "control: the fixture really is corrupt now", String(integrity));

  // `openHub(p)` ALONE, with no probe query after it. Leaning on the query meant
  // the assertion passed only when the damage happened to be somewhere the query
  // read -- and SQLite opens a file with a corrupt index or an untouched table
  // without complaint, so the refusal has to come from openHub's own
  // quick_check rather than from a lucky SELECT.
  let why = null;
  try { openHub(p).close(); } catch (e) { why = e.message; }
  check(why !== null, "a corrupt hub does not open silently: openHub itself refuses");
  // Name the actual newest snapshot, not the word "snapshot". The interface
  // promises the path an operator should restore, and `/snapshot/i` passes on a
  // generic "the snapshot is unreadable" that tells them nothing.
  const newest = latestSnapshot(root, "hub");
  check(newest && (why ?? "").includes(newest),
    "and the refusal names the newest usable snapshot by path", `${why}\n        newest=${newest}`);
}
rmSync(dir, { recursive: true, force: true });
rmSync(home, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
