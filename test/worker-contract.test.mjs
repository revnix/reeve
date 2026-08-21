// Every run records the contract it ran under: which CLI, which model, which
// argv, prompt, settings, tools, and caps. A retry must reuse it verbatim, and
// an alias like `fable` must not drift under a retry. Without the row, "what did
// this worker actually run as" has no answer after the process is gone.
import { open, startRun, recordWorkerContract, noteWorkerModel, workerContractFor, sha256 } from "../src/db/ops.mjs";
import { tick } from "../src/daemon.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-contract-"));
const db = open(join(dir, "c.db"));

// ── the unit ─────────────────────────────────────────────────────────────────
{
  const run = startRun(db, { nwo: "o/r", pr: 7, action: "FIX_CI", head: "a".repeat(40) });
  recordWorkerContract(db, { runId: run.runId, cliVersion: "2.1.237", modelRequested: "fable", effort: "high",
    argvHash: sha256("argv"), promptHash: sha256("prompt"), settingsHash: sha256("settings"), toolContract: "Read,Edit",
    agentsHash: null, maxTurns: 40, maxBudgetUsd: 2, canaryId: null, outPath: "/o", errPath: "/e", pid: 1, lstart: "x" });
  const row = workerContractFor(db, run.runId);
  check(row?.cli_version === "2.1.237" && row.model_requested === "fable" && row.model_resolved === null,
    "a contract row is written at dispatch with the model still unresolved", JSON.stringify(row));
  noteWorkerModel(db, { runId: run.runId, modelResolved: "claude-fable-5" });
  check(workerContractFor(db, run.runId).model_resolved === "claude-fable-5",
    "the resolved model is recorded when the worker announces it");
  check(sha256("a") !== sha256("b") && sha256("a").length === 64, "control: sha256 is a real hash");
}

// ── the wiring: the daemon records it ────────────────────────────────────────
{
  const HEAD = "b".repeat(40);
  const cl = (id, state, detail = "") => ({ id, state, detail });
  const evaluation = {
    ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
    verdict: { state: "BLOCK", summary: "ci is red",
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"]
                 .map(id => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true },
  };
  const ctx = {
    nwo: "o/r", db, logPath: join(dir, "log.txt"), execute: true, shadow: true, running: 0, cliVersion: "2.1.237",
    profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir }, authority: { policy: "propose_and_merge" },
               rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, ci: { provider: "github-actions", requiredChecks: [] },
               watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 } },
    openPrs: () => [42], evaluate: () => evaluation,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", model: "claude-x-resolved" }),
    resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", runId: 11, cause: [{ where: "src/x.ts:1", message: "boom" }] }),
    worktreeFor: () => dir,
  };
  await tick(ctx);
  const row = db.prepare("SELECT w.* FROM worker_run w JOIN run r ON r.id = w.run_id WHERE r.task_id='pr:42'").get();
  check(!!row, "the daemon writes a contract row for its dispatch", JSON.stringify(row));
  check(row?.cli_version === "2.1.237" && /^[0-9a-f]{64}$/.test(row?.argv_hash ?? "") && /^[0-9a-f]{64}$/.test(row?.settings_hash ?? ""),
    "with the CLI version and real hashes", JSON.stringify(row));
  check(row?.model_resolved === "claude-x-resolved", "and the model the worker announced", String(row?.model_resolved));
  check(!!row?.out_path && !!row?.err_path, "and the durable output paths", JSON.stringify([row?.out_path, row?.err_path]));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
