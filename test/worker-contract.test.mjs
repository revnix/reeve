// Every run records the contract it ran under: which CLI, which model, which
// argv, prompt, settings, tools, and caps. A retry must reuse it verbatim, and
// an alias like `fable` must not drift under a retry. Without the row, "what did
// this worker actually run as" has no answer after the process is gone.
import { open, startRun, recordWorkerContract, noteWorkerResult, workerContractFor, sha256 } from "../src/db/ops.mjs";
import { tick } from "../src/daemon.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
  noteWorkerResult(db, { runId: run.runId, modelResolved: "claude-fable-5" });
  check(workerContractFor(db, run.runId).model_resolved === "claude-fable-5",
    "the resolved model is recorded when the worker announces it");
  check(sha256("a") !== sha256("b") && sha256("a").length === 64, "control: sha256 is a real hash");
}

// ── the wiring: the daemon records it ────────────────────────────────────────
{
  const HEAD = "b".repeat(40);
  const cl = (id, state, detail = "") => ({ id, state, detail });
  var evaluation = {
    ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
    verdict: { state: "BLOCK", summary: "ci is red",
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"]
                 .map(id => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true },
  };
  // Each context gets its own worktree dir: the daemon quarantines (moves) a
  // worktree after a failed run, and a shared one strands every later tick.
  var ctxFor = (db_, logPath) => ({
    nwo: "o/r", db: db_, logPath, execute: true, shadow: true, running: 0, containment: { credentialRead: "closed", why: "test" }, keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "2.1.237",
    // Deterministic: the real capacity() backs off on the host's load average, so
    // a busy machine would fail these assertions for a reason that is not the code.
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    // Separate directories, as a real deployment must have them: the worker
    // policy denies reads of the clone, so a checkout inside it is refused.
    profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-wc-clone-")) }, authority: { policy: "propose_and_merge" },
               rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, ci: { provider: "github-actions", requiredChecks: [] },
               watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 } },
    openPrs: () => [42], evaluate: () => evaluation,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    // Injected, never read from disk: the real reader looks at
    // ~/.reeve/claude-token, so a default passes on a machine that happens to
    // have one and fails on CI.
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", runId: 11, cause: [{ where: "src/x.ts:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir, "wt-")), why: null, deps: { ok: true, cow: false } }),
  });
  var seenEnv = null, seenArgs = null;
  const ctx = { ...ctxFor(db, join(dir, "log.txt")),
    spawnWorker: async (args) => { seenEnv = args.env; seenArgs = args; args.onSpawn?.({ pid: 4242, lstart: "Thu Aug 21 19:00:00 2026" }); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", model: "claude-x-resolved", truncated: true, stdoutBytes: 12345 }; } };
  await tick(ctx);
  const row = db.prepare("SELECT w.* FROM worker_run w JOIN run r ON r.id = w.run_id WHERE r.task_id='pr:42'").get();
  check(!!row, "the daemon writes a contract row for its dispatch", JSON.stringify(row));
  check(row?.cli_version === "2.1.237" && /^[0-9a-f]{64}$/.test(row?.argv_hash ?? "") && /^[0-9a-f]{64}$/.test(row?.settings_hash ?? ""),
    "with the CLI version and real hashes", JSON.stringify(row));
  check(row?.model_resolved === "claude-x-resolved", "and the model the worker announced", String(row?.model_resolved));
  check(row?.truncated === 1 && row?.stdout_bytes === 12345, "and whether its durable record was cut, with the byte count", JSON.stringify([row?.truncated, row?.stdout_bytes]));
  check(row?.pid === 4242 && /2026/.test(row?.lstart ?? ""), "and the process identity once the binding succeeds", JSON.stringify([row?.pid, row?.lstart]));
  check(/^[0-9a-f]{64}$/.test(row?.env_hash ?? ""), "and a hash of the exact environment it ran under", String(row?.env_hash));
  // The daemon binds through the revalidating store call, not the plain write.
  const dsrc2 = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  // WHITESPACE-TOLERANT, because the previous form pinned the LAYOUT rather than
  // the wiring: it required `onSpawn` to be a single line beginning with
  // `bindRun`, so adding a second statement to that callback broke a control
  // that has nothing to say about statement count. What must hold is that the
  // spawn callback binds the run through `bindRun`, whatever else it does.
  const spawnBinding = /onSpawn:\s*\(\{\s*pid,\s*lstart\s*\}\)\s*=>\s*\{[\s\S]{0,200}?bindRun\(db/;
  check(spawnBinding.test(dsrc2), "control: the daemon's binding calls bindRun",
    (dsrc2.match(/onSpawn:[\s\S]{0,120}/) ?? [""])[0]);
  // The settings file is immutable per run: two daemons sharing the state dir
  // and a PR number must never overwrite each other's file between the hash
  // and the spawn.
  const argvSettings = seenArgs?.args?.[seenArgs.args.indexOf("--settings") + 1] ?? "";
  check(argvSettings.includes("/runs/o-r/42/") && /sandbox-settings\.json$/.test(argvSettings), "the worker's settings file lives in its own run dir", argvSettings);
  check(!!row?.out_path && !!row?.err_path, "and the durable output paths", JSON.stringify([row?.out_path, row?.err_path]));
  check(/runs\/o-r\/42\/[^/]+\/worker\.out$/.test(row?.out_path ?? ""),
    "the run dir is keyed by repository, PR, and run id, never PR alone", String(row?.out_path));
  check(typeof seenEnv?.TMPDIR === "string" && seenEnv.TMPDIR.includes("/runs/o-r/42/") && /\/tmp$/.test(seenEnv.TMPDIR),
    "and the worker's TMPDIR is inside that run dir", String(seenEnv?.TMPDIR));
}

// ── a contract that cannot be recorded releases the lease ────────────────────
//
// The row is written after the run is leased and its heartbeat started. A
// throw there escaped the cleanup, leaving the interval renewing a lease for a
// worker that never ran, and every later dispatch for the PR refused.
{
  const dir2 = mkdtempSync(join(tmpdir(), "reeve-contract-fail-"));
  const db2 = open(join(dir2, "c.db"));
  db2.exec("DROP TABLE worker_run");   // the insert will throw
  let spawned = 0;
  const ctx2 = { ...ctxFor(db2, join(dir2, "log.txt")), spawnWorker: async () => { spawned++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; } };
  let threw = null;
  try { await tick(ctx2); } catch (e) { threw = e; }
  check(!threw, "the tick survives a contract write failure", String(threw?.message));
  // The recorder fails for the same reason; the backoff installed by the
  // preparation failure must survive that, or the PR is leased and failed
  // again on the very next tick.
  await tick(ctx2);
  check(ctx2.db.prepare("SELECT COUNT(*) n FROM run").get().n === 1, "a second tick stays in the preparation backoff even though the recorder failed too", String(ctx2.db.prepare("SELECT COUNT(*) n FROM run").get().n));
  check(spawned === 0, "and no worker was launched without its contract", String(spawned));
  const run = db2.prepare("SELECT status FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(run?.status === "failed", "the leased run is closed as failed, not left live", JSON.stringify(run));
  // The attempt was spent before preparation; a failure that is reeve's own
  // must not cost the PR one of its retries.
  const spent = db2.prepare("SELECT COALESCE(SUM(attempts),0) n FROM fix_attempt").get().n;
  check(spent === 0, "and the fix attempt spent for it is refunded", String(spent));
  db2.close(); rmSync(dir2, { recursive: true, force: true });
}


// ── result facts that cannot be recorded make the run failed, not published ──
{
  const dir3 = mkdtempSync(join(tmpdir(), "reeve-contract-note-"));
  const db3 = open(join(dir3, "n.db"));
  const ctx3 = { ...ctxFor(db3, join(dir3, "log.txt")), noteWorkerResult: () => { throw new Error("disk full"); },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", model: "m" }) };
  await tick(ctx3);
  const run3 = db3.prepare("SELECT status, error FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(run3?.status === "failed" && /record/.test(run3?.error ?? ""), "an OK worker whose result facts could not be recorded is closed as failed, with the reason", JSON.stringify(run3));
  db3.close(); rmSync(dir3, { recursive: true, force: true });
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
