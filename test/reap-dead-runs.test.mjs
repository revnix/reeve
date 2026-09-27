// A run whose worker died is reaped on the next tick (#162).
//
// A run holds its pull request exclusively, and only the daemon that started it
// finishes it. When that daemon dies with its worker -- a crash, a reboot, a
// service restart that takes both -- the run is left live, and startRun refused
// the pull request until it merged. These tests leave a store exactly as such a
// daemon does: a run started and bound to a real worker process, and its lease
// lapsed. Then a new daemon's tick runs over that store.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { open, startRun, bindRun } from "../src/db/ops.mjs";
import { readStart } from "../src/supervisor.mjs";
import { statePathFor } from "../src/paths.mjs";
import { run, HEAD } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

// A store with one live run for o/r#42, bound to a real worker, its lease lapsed.
// The worker killed, or still running.
const leftBehind = async ({ killWorker }) => {
  const dbPath = join(tempDir("reap-"), "s.db");
  const db = open(dbPath);
  const started = startRun(db, { nwo: "o/r", pr: 42, action: "FIX_CI", head: HEAD });
  assert.ok(started.ok, started.why);
  const worker = spawn("sleep", ["60"], { stdio: "ignore" });
  await once(worker, "spawn");
  bindRun(db, { runId: started.runId, pid: worker.pid, boot: readStart(worker.pid) });
  if (killWorker) {
    worker.kill("SIGKILL");
    await once(worker, "exit");
  }
  db.prepare("UPDATE run SET lease_expires_at = unixepoch() - 1 WHERE id = ?").run(started.runId);
  db.close();
  return { dbPath, runId: started.runId, worker };
};
// The run's row once the tick is done. The harness closes the store it ran on.
const runRow = (dbPath, runId) => {
  const db = open(dbPath);
  try { return db.prepare("SELECT status, lease_expires_at FROM run WHERE id = ?").get(runId); }
  finally { db.close(); }
};

test("a run whose worker died is reaped on the next tick, and its pull request is worked again", async () => {
  const { dbPath, runId } = await leftBehind({ killWorker: true });
  const out = await run({ dbPath });
  assert.equal(runRow(dbPath, runId).status, "abandoned", out.log.slice(-1500));
  assert.equal(out.spawned.length, 1, `no worker was dispatched for the pull request:\n${out.log.slice(-1500)}`);
});

test("a run whose worker is still running keeps its pull request, though its lease lapsed", async () => {
  const { dbPath, runId, worker } = await leftBehind({ killWorker: false });
  try {
    const out = await run({ dbPath });
    const row = runRow(dbPath, runId);
    assert.equal(row.status, "running", out.log.slice(-1500));
    assert.ok(row.lease_expires_at > Math.floor(Date.now() / 1000), "the live worker's lease wasn't extended");
    assert.equal(out.spawned.length, 0, "a second worker was dispatched beside the live one");
  } finally {
    worker.kill("SIGKILL");
  }
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
});
