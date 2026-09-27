// The runs a dead daemon left are reaped on the next tick (#162).
//
// A run holds its pull request exclusively, and only the daemon that started it
// finishes it. When that daemon dies with its worker -- a crash, a reboot, a
// service restart that takes both -- the run is left live, and startRun refused
// the pull request until it merged. These tests leave a store as such a daemon
// does: a run started and bound to a real worker process, and its lease lapsed.
// Then a new daemon's tick runs over that store.
//
// A worker still running on a lapsed lease has no claim anything will renew: its
// supervisor is gone, or stalled past its lease. So it's stopped, as the
// supervisor stops a worker whose lease it can no longer prove, and its run is
// reaped once it's gone. Its claim is never renewed, which would let a stalled
// supervisor publish work it no longer holds.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { open, startRun, bindRun, reap } from "../src/db/ops.mjs";
import { readStart } from "../src/supervisor.mjs";
import { statePathFor } from "../src/paths.mjs";
import { runPathFor } from "../src/checkout.mjs";
import { tick } from "../src/daemon.mjs";
import { run, HEAD } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

// A store with one live run for o/r#42, bound to a real worker in a process
// group of its own, as workers are, and its lease lapsed. `boot` overrides the
// start time recorded for it.
const leftBehind = async ({ killWorker, boot = null }) => {
  const dbPath = join(tempDir("reap-"), "s.db");
  const db = open(dbPath);
  const started = startRun(db, { nwo: "o/r", pr: 42, action: "FIX_CI", head: HEAD });
  assert.ok(started.ok, started.why);
  const worker = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  await once(worker, "spawn");
  bindRun(db, { runId: started.runId, pid: worker.pid, boot: boot ?? readStart(worker.pid) });
  if (killWorker) {
    worker.kill("SIGKILL");
    await once(worker, "exit");
  }
  db.prepare("UPDATE run SET lease_expires_at = unixepoch() - 1 WHERE id = ?").run(started.runId);
  db.close();
  return { dbPath, runId: started.runId, worker };
};
// The run's row once a tick is done. The harness closes the store it ran on.
const runRow = (dbPath, runId) => {
  const db = open(dbPath);
  try { return db.prepare("SELECT status, lease_expires_at FROM run WHERE id = ?").get(runId); }
  finally { db.close(); }
};
const now = () => Math.floor(Date.now() / 1000);
// Whether the worker has exited, waiting up to `ms` for it.
const exits = (worker, ms = 5000) => worker.exitCode !== null || worker.signalCode !== null
  ? Promise.resolve(true)
  : Promise.race([once(worker, "exit").then(() => true), new Promise((r) => setTimeout(() => r(false), ms).unref())]);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a run whose worker died is reaped on the next tick, and its pull request is free to be worked again", async () => {
  const { dbPath, runId } = await leftBehind({ killWorker: true });
  const out = await run({ dbPath });
  assert.equal(runRow(dbPath, runId).status, "abandoned", out.log.slice(-1500));
  assert.equal(out.spawned.length, 1, `no worker was dispatched for the pull request:\n${out.log.slice(-1500)}`);
});

test("a worker still running on a lapsed lease is stopped and its run reaped in the same tick, its claim never renewed", async () => {
  const { dbPath, runId, worker } = await leftBehind({ killWorker: false });
  try {
    const out = await run({ dbPath });
    assert.ok(await exits(worker), `the worker wasn't stopped:\n${out.log.slice(-1500)}`);
    const row = runRow(dbPath, runId);
    assert.equal(row.status, "abandoned", out.log.slice(-1500));
    assert.ok(row.lease_expires_at < now(), "the lapsed claim was renewed");
    // Handled in this pass, so nothing tells a person it's unworked.
    assert.doesNotMatch(out.esc, /past its lease/, "the tick paged about a run it had just handled");
  } finally {
    try { process.kill(-worker.pid, "SIGKILL"); } catch { /* stopped */ }
  }
});

test("a halted tick stops a worker left running on a lapsed lease", async () => {
  const { dbPath, runId, worker } = await leftBehind({ killWorker: false });
  const haltMarker = join(tempDir("reap-halt-"), "HALT");
  writeFileSync(haltMarker, "");
  try {
    const out = await run({ dbPath, haltMarker });
    assert.equal(out.spawned.length, 0);
    assert.ok(await exits(worker), `a halted tick left the orphaned worker running:\n${out.log.slice(-1500)}`);
    assert.equal(runRow(dbPath, runId).status, "abandoned", out.log.slice(-1500));
  } finally {
    try { process.kill(-worker.pid, "SIGKILL"); } catch { /* stopped */ }
  }
});

test("a pid now held by another process is never signalled: its run is reaped as dead, and the process left alone", async () => {
  // The recorded start time isn't this process's, as when the worker died and
  // its pid was given to a stranger.
  const { dbPath, runId, worker } = await leftBehind({ killWorker: false, boot: "Thu Jan  1 00:00:00 1970" });
  try {
    const out = await run({ dbPath });
    assert.equal(runRow(dbPath, runId).status, "abandoned", out.log.slice(-1500));
    assert.equal(alive(worker.pid), true, "a process that isn't the worker was signalled");
  } finally {
    try { process.kill(-worker.pid, "SIGKILL"); } catch { /* gone */ }
  }
});

test("a run whose lease lapses this very second is reaped, as heartbeat already treats it as lost", () => {
  const db = open(join(tempDir("reap-edge-"), "s.db"));
  try {
    const started = startRun(db, { nwo: "o/r", pr: 42, action: "FIX_CI", head: HEAD });
    // The lease ends at the second the reaper reads as now.
    const at = now() + 60;
    db.prepare("UPDATE run SET lease_expires_at = ? WHERE id = ?").run(at, started.runId);
    assert.deepEqual(reap(db, { isAlive: () => false, now: at }).map((r) => r.action), ["reaped"]);
  } finally {
    db.close();
  }
});

test("a reaped run's checkout is preserved as a failed run's is, not left behind", async () => {
  const root = tempDir("reap-root-");
  const dbPath = join(tempDir("reap-co-"), "s.db");
  const db = open(dbPath);
  const started = startRun(db, { nwo: "o/r", pr: 42, action: "FIX_CI", head: HEAD });
  db.prepare("UPDATE run SET lease_expires_at = unixepoch() - 1 WHERE id = ?").run(started.runId);
  const checkout = runPathFor(root, 42, started.runId);
  mkdirSync(checkout, { recursive: true });
  writeFileSync(join(checkout, "work.txt"), "a worker's unfetched change\n");
  // GitHub can't be asked, so the tick stops after its housekeeping.
  await tick({ nwo: "o/r", db, logPath: join(dirname(dbPath), "reeve.log"), execute: false, shadow: true,
               profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: root } },
               openPrs: () => null });
  db.close();
  assert.equal(runRow(dbPath, started.runId).status, "abandoned");
  assert.equal(existsSync(checkout), false, "the dead run's checkout was left where it was");
  assert.equal(existsSync(join(`${checkout}.unfetched`, "work.txt")), true, "the dead run's checkout wasn't preserved");
});

test("the doctor's advice for a run past its lease is the daemon's next tick, not a command that was never built", () => {
  const home = tempDir("reap-doctor-");
  const nwo = "owner-x/repo-y";
  const profilePath = join(home, "profiles", "owner-x", "repo-y.json");
  mkdirSync(dirname(profilePath), { recursive: true });
  writeFileSync(profilePath, JSON.stringify({
    schemaVersion: 1, project: { kind: "product" },
    identity: { key: nwo, defaultBranch: "main", visibility: "private" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "sibling", location: "owner-x/repo-y-ledger" },
    units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm", commands: { test: { cmd: "npm test", state: "present" } } }],
    ci: { provider: "none" }, merge: { method: "squash", enforcement: "attested" },
  }));
  const dbPath = statePathFor(home, nwo);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = open(dbPath);
  db.prepare("INSERT INTO node (id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("pr:7", "pr", `${nwo}#7`, 1, 1);
  db.prepare(`INSERT INTO run (id, task_id, lane, status, lease_expires_at, heartbeat_at, owner_host, started_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run("run-1", "pr:7", "fixer", "running", 1, 1, "test-host", 1);
  db.close();
  // No gh on the PATH: this is about the lease check, and the GitHub checks degrade.
  const bin = fileURLToPath(new URL("../bin/reeve", import.meta.url));
  const r = spawnSync(process.execPath, [bin, "doctor", nwo, "--json"],
                      { encoding: "utf8", env: { ...process.env, REEVE_HOME: home, PATH: join(home, "no-tools") } });
  const leases = JSON.parse(r.stdout).checks.find((c) => c.id === "R-06");
  assert.ok(leases, `${r.stdout.slice(0, 300)} ${r.stderr.slice(0, 300)}`);
  assert.ok(leases.lines.some((l) => /past lease expiry/.test(l)), "control: the run wasn't read as past its lease");
  assert.ok(leases.lines.some((l) => /reaps these on its next tick/.test(l)), JSON.stringify(leases.lines));
  assert.ok(!leases.lines.some((l) => /lane reap/.test(l)), JSON.stringify(leases.lines));
  // The reaper stops a worker still running on a lapsed lease; it renews nothing.
  assert.ok(!leases.lines.some((l) => /extends the lease/.test(l)), JSON.stringify(leases.lines));
});
