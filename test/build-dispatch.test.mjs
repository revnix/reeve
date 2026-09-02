// The dispatch seam: what a phase runs, and the row that exists before the
// process does.
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHub } from "../src/build/hubdb.mjs";
import { runStatus, liveRuns } from "../src/build/run.mjs";
import { PHASE_SPECS, specFor, contractSnapshot, contractDrift, dispatchPhase } from "../src/build/dispatch.mjs";
import { OUTCOMES, readStart } from "../src/supervisor.mjs";
import { applyTransition } from "../src/build/transition.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-dispatch-"));
const db = openHub(join(dir, "hub.db"));
const alive = () => true;
db.exec(
  `INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
     repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
   VALUES('bt:d','p',7,'o/r','t','RESEARCH',1,'founder','k','/p','/f','h','main','private',1,
          unixepoch(),unixepoch())`);

// ── the phase registry, and the boundary of the whole stage ──────────────────
{
  check(specFor("SPEC_DRAFT") === null,
    "SPEC_DRAFT dispatches nothing: that absence IS the boundary between S3 and S4",
    JSON.stringify(specFor("SPEC_DRAFT")));
  check(Object.hasOwn(PHASE_SPECS, "SPEC_DRAFT") === false,
    "control: and it is absent from the table rather than present and falsy");

  // A PHASE NAME COMES OUT OF THE DATABASE, so this lookup takes untrusted
  // input. A plain object literal answers `toString` with a function and
  // `__proto__` with the prototype -- a "spec" nobody wrote, reached by a name
  // nobody registered.
  for (const hostile of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"])
    check(specFor(hostile) === null,
      `a phase named ${hostile} resolves to null, not to Object's prototype`,
      JSON.stringify(specFor(hostile)));

  check(Object.getPrototypeOf(PHASE_SPECS) === null,
    "control: the table has a null prototype, which is what makes that true by construction");
  check(Object.isFrozen(PHASE_SPECS),
    "control: and it is frozen, so a phase cannot be registered at runtime");
}

// ── the contract snapshot ────────────────────────────────────────────────────
const LIVE = { cliVersion: "1.2.3", model: "claude-fable-4-5-20260101", effort: "high",
               argv: ["-p", "x"], prompt: "P", settings: "S", tools: "T", agents: "A",
               maxTurns: 60, maxBudgetUsd: 5, canaryId: "c-1", registrySnapshotHash: "f".repeat(64) };
{
  const snap = contractSnapshot(LIVE);
  check(snap.ok === true, "a fully resolved model produces a snapshot", JSON.stringify(snap).slice(0, 120));
  check(snap.argvHash.length === 64 && snap.promptHash.length === 64,
    "and every hash is sha256 hex of the canonical bytes", `${snap.argvHash.length}/${snap.promptHash.length}`);

  // AN ALIAS RESOLVES DIFFERENTLY AFTER AN UPGRADE, so the task's model would
  // change with nobody deciding it. Refused here rather than resolved, which
  // would make this function do I/O.
  const aliased = contractSnapshot({ ...LIVE, model: "fable" });
  check(aliased.ok === false && /fully resolved/.test(aliased.error),
    "an alias is refused rather than resolved", JSON.stringify(aliased));

  // `ok` ON BOTH PATHS. A refusal shaped {ok:false} beside a success carrying no
  // `ok` at all makes `if (!snap.ok)` true for a perfectly good snapshot.
  check("ok" in snap && "ok" in aliased,
    "control: both the success and the refusal carry `ok`, so one test tells them apart");
}

// ── drift is recorded, and null when there is none ───────────────────────────
{
  const snap = contractSnapshot(LIVE);
  check(contractDrift(snap, snap) === null,
    "an unchanged environment drifts by null, not by {}: an empty object is truthy and would record drift on every clean dispatch",
    JSON.stringify(contractDrift(snap, snap)));
  const moved = contractDrift(snap, { ...snap, cliVersion: "9.9.9", effort: "low" });
  check(moved && moved.cliVersion.was === "1.2.3" && moved.cliVersion.now === "9.9.9",
    "a changed field is recorded as was/now", JSON.stringify(moved));
  check(moved && Object.keys(moved).length === 2,
    "control: and only the fields that actually moved", JSON.stringify(moved));
}

// EVERY FIELD THE SNAPSHOT CARRIES, and the list is derived from the snapshot
// rather than written again. A hand-kept list is a second spelling of
// contractSnapshot's shape and had already drifted from it: a live profile
// change to the worker's own limits reported a perfectly clean dispatch.
{
  const snap = contractSnapshot(LIVE);
  for (const [field, value] of [["maxTurns", 1], ["maxBudgetUsd", 99],
                                ["argvHash", "0".repeat(64)], ["promptHash", "0".repeat(64)],
                                ["canaryId", "other"]]) {
    const d = contractDrift(snap, { ...snap, [field]: value });
    check(d !== null && d[field] && d[field].now === value,
      `a changed ${field} is drift`, JSON.stringify(d));
  }
  // CONTROL, the other direction: the loop above would pass on a function that
  // reported every field as drifted.
  check(contractDrift(snap, { ...snap }) === null,
    "control: and an identical environment still drifts by null, so the check is not just reporting everything",
    JSON.stringify(contractDrift(snap, { ...snap })));
  // And the coverage is COMPLETE rather than a longer list: every contract
  // field the snapshot carries must be reachable by drift.
  const uncovered = Object.keys(snap).filter((f) => f !== "ok" &&
    contractDrift(snap, { ...snap, [f]: "changed-to-something-else" }) === null);
  check(uncovered.length === 0,
    "every field the snapshot carries is compared, so a field added to the contract cannot be silently unwatched",
    JSON.stringify(uncovered));
}

// ── the row exists before the process, and is settled after it ───────────────
const KEY = { task: "bt:d", generation: 1, phase: "RESEARCH", slice: 0, attempt: 1 };
const DISPATCH_ARGV = ["-p", "go"];
const base = (over = {}) => ({
  ...KEY, home: dir, argv: DISPATCH_ARGV, env: {}, cwd: dir,
  snapshot: contractSnapshot({ ...LIVE, argv: DISPATCH_ARGV }), drift: null, leaseSeconds: 400, budgetMs: 1000,
  now: () => 1000, isAlive: alive,
  bind: () => KEY,
  ...over,
});

{
  let sawRowDuringRun = null;
  const r = await dispatchPhase(db, base({
    run: async ({ onSpawn }) => {
      onSpawn({ pid: 4242, lstart: "42" });
      // The property: by the time a process exists, the row already does.
      sawRowDuringRun = runStatus(db, KEY);
      return { outcome: OUTCOMES.OK, why: "done", truncated: false };
    },
  }));
  check(sawRowDuringRun === "live",
    "the run row is live BEFORE the worker runs, so no window hides a live worker from admission",
    String(sawRowDuringRun));
  check(r.ok === true && r.runKey.task === "bt:d",
    "a successful dispatch answers with its run key", JSON.stringify(r).slice(0, 160));
  check(Array.isArray(r.argv) && r.env !== undefined,
    "and with the argv and env it dispatched, so the tick does not re-derive them into a second spelling",
    JSON.stringify({ argv: r.argv, env: r.env }));
  check(runStatus(db, KEY) === "succeeded", "and the row is settled after", String(runStatus(db, KEY)));

  const argvPath = join(dir, "tasks", "bt:d", "runs", "g1-RESEARCH-s0-a1.argv.json");
  check(existsSync(argvPath), "the complete argv is written beside the run, not only its hash", argvPath);
  check(JSON.parse(readFileSync(argvPath, "utf8")).argv.join(" ") === "-p go",
    "control: and it is the argv that was actually dispatched");
}

// ── a rejection is an outcome too ────────────────────────────────────────────
//
// The `finally` that clears the heartbeat does not settle the row. A runWorker
// that THREW rather than returning therefore left phase_run saying `live` for a
// process that is gone -- and `one_live_run` then refuses the task's next
// dispatch forever, on behalf of nothing. Nobody sees it until the task simply
// stops progressing.
{
  const K2 = { ...KEY, attempt: 2 };
  const r = await dispatchPhase(db, base({ attempt: 2, run: async () => { throw new Error("spawn exploded"); } }));
  check(r.ok === false && r.reason === "dispatch-threw",
    "a dispatch that throws answers with a refusal rather than propagating", JSON.stringify(r));
  check(runStatus(db, K2) === "failed",
    "and the run row is SETTLED, not left live for a process that is gone", String(runStatus(db, K2)));
  check(liveRuns(db).length === 0,
    "control: so nothing is still holding the task's one live slot",
    JSON.stringify(liveRuns(db).map((x) => [x.task, x.attempt, x.status])));

  // The proof that it matters: the next attempt is admitted.
  const next = await dispatchPhase(db, base({
    attempt: 3, run: async () => ({ outcome: OUTCOMES.OK, why: "ok", truncated: false }),
  }));
  check(next.ok === true, "and the task can dispatch again", JSON.stringify(next).slice(0, 120));
}

// ── UNBOUND is a refusal, and the row still settles ──────────────────────────
{
  const K4 = { ...KEY, attempt: 4 };
  const r = await dispatchPhase(db, base({
    attempt: 4,
    run: async () => ({ outcome: OUTCOMES.UNBOUND, why: "could not record pid", pid: 99, truncated: false }),
  }));
  check(r.ok === false && r.reason === "unbound",
    "a worker that could not be recorded is a refusal", JSON.stringify(r).slice(0, 140));
  check(runStatus(db, K4) === "failed",
    "and its row is settled rather than left live", String(runStatus(db, K4)));
}

// ── a refused insert never spawns ────────────────────────────────────────────
{
  const K5 = { ...KEY, attempt: 5 };
  let spawned = false;
  // attempt 1 is settled, so re-using its number is a duplicate-attempt refusal.
  const r = await dispatchPhase(db, base({ attempt: 1, run: async () => { spawned = true; return { outcome: OUTCOMES.OK }; } }));
  check(r.ok === false && r.reason === "duplicate-attempt",
    "an insert the database refuses is answered with its reason", JSON.stringify(r));
  check(spawned === false,
    "and NOTHING was spawned: the row is the permission to run, so a refused row must not produce a process",
    String(spawned));
  check(runStatus(db, K5) === null, "control: and no row appeared for the attempt that was refused");
}

// ── the argv that runs is the argv the snapshot names ────────────────────────
{
  const r = await dispatchPhase(db, base({ attempt: 7, argv: ["-p", "something-else"] }));
  check(r.ok === false && r.reason === "argv-does-not-match-the-snapshot",
    "argv the snapshot does not name is refused before anything is granted", JSON.stringify(r).slice(0, 150));
  check(runStatus(db, { ...KEY, attempt: 7 }) === null,
    "and no row was written for it, so nothing records a contract that was never run",
    String(runStatus(db, { ...KEY, attempt: 7 })));
}

// ── a refused dispatch does not overwrite a settled attempt's argv record ────
{
  const argvPath = join(dir, "tasks", "bt:d", "runs", "g1-RESEARCH-s0-a1.argv.json");
  // A missing file must not READ as unchanged: two absences compare equal, and
  // the assertion below would pass on a dispatcher that never wrote the record
  // at all. So the read answers null on absence and a control demands content.
  const readOr = (f) => { try { return readFileSync(f, "utf8"); } catch { return null; } };
  const before = readOr(argvPath);
  check(typeof before === "string" && before.length > 0,
    "control: the settled attempt has a durable argv record to protect", String(before).slice(0, 40));
  // attempt 1 is settled, so this is a duplicate-attempt refusal -- and it
  // carries DIFFERENT argv, with its own snapshot naming it, because that is
  // what makes an overwrite observable. Re-dispatching the same argv writes
  // identical bytes and the assertion cannot see the defect it is here for.
  const OTHER = ["-p", "a-retry-that-never-ran"];
  const r = await dispatchPhase(db, base({ attempt: 1, argv: OTHER,
                                           snapshot: contractSnapshot({ ...LIVE, argv: OTHER }) }));
  check(r.ok === false && r.reason === "duplicate-attempt", "control: the re-dispatch is refused", JSON.stringify(r));
  check(readOr(argvPath) === before,
    "and the settled attempt's argv record is untouched: the row keeps its argv_hash, so a file holding other bytes would make the audit trail disagree with itself",
    "the file changed");
}

// ── the session id is learned late, and is persisted ─────────────────────────
{
  const K8 = { ...KEY, attempt: 8 };
  const r = await dispatchPhase(db, base({
    attempt: 8,
    // The real runWorker binds a null at onSpawn and learns the id from the
    // worker's init event, so it arrives here and nowhere earlier.
    run: async ({ onSpawn }) => { onSpawn({ pid: 1234, lstart: "1" });
      return { outcome: OUTCOMES.OK, why: "done", truncated: false, sessionId: "sess-abc" }; },
    bind: undefined,
  }));
  check(r.ok === true, "control: the dispatch succeeded", JSON.stringify(r).slice(0, 100));
  const row = db.prepare("SELECT session_id FROM phase_run WHERE task='bt:d' AND attempt=8").get() ?? {};
  check(row.session_id === "sess-abc",
    "the session the worker reported is persisted, so --resume has something to resume",
    JSON.stringify(row));
}

// ── a heartbeat that could not be written revokes the worker ─────────────────
//
// The failure is not self-correcting from the row's side: revocationProbe reads
// a lease_expires_at still in the future -- precisely because nobody could move
// it -- and answers null. Without this the worker acts for the rest of the lease
// with a claim nobody renewed. A live maintenance lock is the case that matters:
// writes are refused for the whole of a restore, which is exactly when a worker
// must not still be acting.
{
  const K9 = { ...KEY, attempt: 9 };
  let probes = 0, sawRevocation = null;
  const r = await dispatchPhase(db, base({
    attempt: 9,
    // Real time, so the lease is genuinely live while this runs -- a frozen
    // clock makes revocationProbe report an expiry and answer first, which
    // would prove the ordering rather than this property.
    now: () => Math.floor(Date.now() / 1000),
    // 4s puts the heartbeat interval at its 1s floor, so a beat is attempted
    // well before the lease could expire.
    leaseSeconds: 4,
    run: async ({ onSpawn, isRevoked }) => {
      onSpawn({ pid: 4321, lstart: "1" });
      // Taken AFTER the row exists, because insertRun refuses under it too --
      // the point is a write that starts failing mid-run.
      db.exec(`INSERT INTO maintenance_lock(name, pid, lstart, acquired_at)
               VALUES('restore', ${process.pid}, 'x', unixepoch())`);
      const until = Date.now() + 3000;
      while (Date.now() < until && sawRevocation == null) {
        probes++; sawRevocation = isRevoked();
        if (sawRevocation == null) await new Promise((res) => setTimeout(res, 100));
      }
      db.exec("DELETE FROM maintenance_lock WHERE name='restore'");
      return { outcome: sawRevocation ? OUTCOMES.LEASE_LOST : OUTCOMES.OK,
               why: String(sawRevocation), truncated: false };
    },
    bind: undefined,
    // The lock's holder reads ALIVE, so assertWritable refuses rather than
    // reaping it -- which is what makes the write fail.
    isAlive: () => true,
  }));
  check(probes > 0, "control: the seam was actually asked", String(probes));
  check(typeof sawRevocation === "string" && /heartbeat/.test(sawRevocation),
    "a heartbeat that could not be written revokes the worker rather than being swallowed",
    String(sawRevocation));
  check(r.ok === true && r.result.outcome === OUTCOMES.LEASE_LOST,
    "control: and the run settles as a lost lease rather than a success", JSON.stringify(r?.result?.outcome));
}

// ── a cancelled task's worker process is DEAD, not merely marked dead ────────
//
// MEASURED at 16cd880: transition.mjs's `terminate-worker` marks
// phase_run.status='killed' and kills no OS process. `reeve task cancel` would
// therefore return success, the task would read CANCELLING, and the worker would
// keep running, keep writing its artifact, and keep drawing on the subscription.
// The failure is silent in the direction that reads as working.
//
// So the assertion is the PROCESS, never the row. A test that checked the status
// would pass against the exact defect it exists to catch: the compensation sets
// that status whether or not anything died. The process dies only because the
// dispatch seam handed runWorker an isRevoked that reads the row.
{
  const K6 = { ...KEY, attempt: 6 };
  const LIVE_ARGV = ["-e", "setInterval(() => {}, 1000)"];
  // Alive until killed, and it exits on SIGTERM by default -- which is what a
  // cooperative cancel is supposed to achieve.
  const pending = dispatchPhase(db, {
    ...KEY, attempt: 6, home: dir, bin: process.execPath, argv: LIVE_ARGV,
    env: {}, cwd: dir, snapshot: contractSnapshot({ ...LIVE, argv: LIVE_ARGV }), drift: null,
    leaseSeconds: 400, budgetMs: 25000, isAlive: alive,
  });

  // Wait for the BINDING, not for a fixed delay: a sleep long enough to be safe
  // on this machine is a flake on a loaded one, and a sleep too short reads as
  // "no process" for the wrong reason.
  const until = Date.now() + 15000;
  let pid = null;
  while (Date.now() < until && pid == null) {
    pid = db.prepare("SELECT pid FROM phase_run WHERE task='bt:d' AND attempt=6").get()?.pid ?? null;
    if (pid == null) await new Promise((r) => setTimeout(r, 50));
  }
  check(Number.isInteger(pid) && pid > 0, "a real worker process was bound to the run row", String(pid));
  check(readStart(pid) !== null,
    "control: the fixture worker is genuinely ALIVE before the cancel -- one that had already exited could not exhibit the defect",
    String(readStart(pid)));

  const t = applyTransition(db, { taskId: "bt:d", expectedPhase: "RESEARCH", expectedGeneration: 1,
    evidence: { kind: "founder.cancel", reason: "the founder cancelled" }, op: "task.cancelling" });
  check(t.applied === true && t.to === "CANCELLING", "the cancel transition applied", JSON.stringify(t));
  check(db.prepare("SELECT status FROM phase_run WHERE task='bt:d' AND attempt=6").get().status === "killed",
    "and `terminate-worker` marked the row killed -- which is ALL it does");

  // THE ASSERTION. runWorker polls isRevoked every 2,000 ms and then sends
  // SIGTERM to the process GROUP, so the wait is bounded by the poll plus the
  // grace, not by anything this test chooses.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && readStart(pid) !== null) await new Promise((r) => setTimeout(r, 100));
  check(readStart(pid) === null,
    "THE PROCESS GROUP IS DEAD -- not merely marked dead", String(readStart(pid)));

  const r = await pending;
  check(r.result?.outcome === OUTCOMES.CANCELLED,
    "and the run is classified as a cancellation rather than a failure, because the operator asked",
    JSON.stringify(r?.result?.outcome ?? r));
  check(runStatus(db, K6) === "killed", "control: and the row still reads killed after the settle");
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
