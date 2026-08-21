// The dispatch path had NO test, because driving it needs GitHub and a live
// `claude`. A ReferenceError sat in it undetected as a result: `cause` and `fp`
// were declared inside the per-PR loop and read from the dispatch loop, a
// separate block, so every FIX_CI would have thrown the moment --execute was on.
// The unit tests around it were all green.
//
// This drives a whole tick with the collaborators stubbed, which is the
// integration the audit named as missing: daemon -> durable run -> worker ->
// finish, and the refusal to re-dispatch work already in flight.
import { tick } from "../src/daemon.mjs";
import { open, liveRunFor, countFixAttempts } from "../src/db/ops.mjs";
import { causeKey } from "../src/ci-rootcause.mjs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-e2e-"));
const dbPath = join(dir, "e.db");
const logPath = join(dir, "log.txt");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const HEAD = "a".repeat(40);
const CAUSE = { ok: true, job: "CI Gate", step: "Test",
                cause: [{ where: "src/x.ts:1", message: "boom" }] };

const profile = {
  identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir },
  authority: { policy: "propose_and_merge" },
  rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
  ci: { provider: "github-actions", requiredChecks: [] },
  watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
};

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

let spawned = [];
const baseCtx = () => ({
  nwo: "o/r", profile, db: open(dbPath), logPath,
  execute: true, shadow: true, running: 0,
  // The tests below exercise dispatch, so they declare what the real module
  // cannot yet: a closed credential read. The default refuses; see the last case.
  containment: { credentialRead: "closed", why: "test" },
  // The worker is stubbed, so no CLI is resolved or launched: the seam is
  // given an absolute path and a version, which is what a real dispatch records.
  claudeBin: "/bin/sh", cliVersion: "test",
  openPrs: () => [42],
  evaluate: () => evaluation,
  publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
  spawnWorker: async (args) => { spawned.push(args); return { outcome: "ok", why: "done", ms: 1200, cost: 0.5, sessionId: "s1" }; },
  // rootCause reaches the network; the tick resolves it before deciding, so it
  // is stubbed at the same seam the daemon uses.
  resolveCause: () => CAUSE,
  worktreeFor: () => dir,
});

const ctx = baseCtx();
const r1 = await tick(ctx);

check(Array.isArray(r1.decisions) && r1.decisions.length === 1,
  "control: the tick produced one decision", JSON.stringify(r1.decisions?.length));

// The ReferenceError this test exists for would have thrown before here.
check(spawned.length === 1, "a worker was dispatched for the red PR", `spawned=${spawned.length}`);

{
  const run = ctx.db.prepare("SELECT status, task_id, owner_pid FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(run?.task_id === "pr:42", "a durable run was created, bound to the PR", JSON.stringify(run));
  check(run?.status === "succeeded", "and closed with the worker's outcome", JSON.stringify(run));
}
{
  const fp = causeKey("o/r", CAUSE);
  check(countFixAttempts(ctx.db, "o/r", 42, fp) === 1,
    "exactly one attempt was spent", String(countFixAttempts(ctx.db, "o/r", 42, fp)));
}
{
  check(liveRunFor(ctx.db, "o/r", 42) === null, "no run is left live after a clean finish");
}

// --- the second tick: the cap must now refuse -------------------------------
{
  spawned = [];
  const r2 = await tick(ctx);
  check(spawned.length === 0,
    "the same failure a second time does NOT dispatch again — the cap is real end to end",
    `spawned=${spawned.length}`);
  const esc = [...(r2.escalations?.keys() ?? [])].join(" | ");
  check(/survived a fix|already attempted|repeat/i.test(esc) || r2.decisions?.[0]?.decision?.action === "ESCALATE",
    "and it escalates instead", esc || JSON.stringify(r2.decisions?.[0]?.decision));
}


// --- lease loss reaches the worker ------------------------------------------
//
// The daemon's heartbeat interval ignored `heartbeat()`'s answer. The stub
// worker here abandons the run underneath the daemon, as an expired lease
// would, waits past one heartbeat, then asks the daemon's own `isRevoked`
// whether it knows.
{
  const dir3 = mkdtempSync(join(tmpdir(), "reeve-e2e-lease-"));
  // Its own worktree dir: the daemon quarantines (moves) a worktree after a
  // failed run, and a block that lent the shared dir would strand every later one.
  const ctx3 = { ...baseCtx(), db: open(join(dir3, "l.db")), logPath: join(dir3, "log.txt"), heartbeatMs: 100,
                 worktreeFor: () => mkdtempSync(join(dir3, "wt-")) };
  let sawRevoked = null;
  ctx3.spawnWorker = async (args) => {
    ctx3.db.prepare("UPDATE run SET status='abandoned' WHERE status IN ('leased','running')").run();
    await new Promise(r => setTimeout(r, 400));
    sawRevoked = args.isRevoked?.();
    return { outcome: "lease_lost", why: `lease revoked: ${sawRevoked}`, ms: 400, cost: 0, sessionId: "s3" };
  };
  await tick(ctx3);
  check(typeof sawRevoked === "string" && /lease/.test(sawRevoked),
    "the daemon tells the worker its lease is gone", String(sawRevoked));
  // The run was abandoned by another actor; a stale worker's finish must not
  // overwrite that with its own "failed" and flip the PR node underneath a
  // replacement run.
  const after = ctx3.db.prepare("SELECT status FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(after?.status === "abandoned", "a lost lease leaves the newer run state untouched", JSON.stringify(after));
  ctx3.db.close();
  rmSync(dir3, { recursive: true, force: true });
}


// --- the default refuses to dispatch while the credential read is open ------
//
// workerenv.mjs declares CONTAINMENT.credentialRead = "open" until a measured
// mechanism closes it. A daemon started with --execute must not launch a worker
// that can read the founder's token; it says so, once, as an identity.
{
  const dir4 = mkdtempSync(join(tmpdir(), "reeve-e2e-contain-"));
  const ctx4 = { ...baseCtx(), db: open(join(dir4, "c.db")), logPath: join(dir4, "log.txt"), worktreeFor: () => mkdtempSync(join(dir4, "wt-")) };
  delete ctx4.containment;          // the real module's declaration applies
  let launched = 0;
  ctx4.spawnWorker = async () => { launched++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const r4 = await tick(ctx4);
  check(launched === 0, "no worker launches under the real containment declaration", String(launched));
  const keys = [...(r4.escalations?.keys() ?? [])];
  check(keys.includes("guardian:containment:open"), "and the refusal is a standing escalation with an identity key", keys.join(" | "));
  check(!/open \d|\d+ worker/.test(keys.join(" ")), "the key carries no counts", keys.join(" | "));
  const log4 = readFileSync(join(dir4, "log.txt"), "utf8");
  check(/NOT dispatching/.test(log4) && /credential/.test(log4), "the log names the reason", log4.split("\n").filter(l => /dispatch/.test(l)).join(" | ").slice(0, 300));
  // Every action promptFor can dispatch is a worker task, SPILL included; the
  // refusal must count them from one shared list, not a hand-copied subset.
  const { WORKER_ACTIONS } = await import("../src/prompts.mjs");
  check(WORKER_ACTIONS.includes("SPILL") && WORKER_ACTIONS.includes("FIX_CI"), "control: the shared worker-action list names SPILL", WORKER_ACTIONS.join(","));
  const dsrc = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(/WORKER_ACTIONS\.includes\(d\.decision\.action\)/.test(dsrc), "and the containment refusal filters by that list", "");
  ctx4.db.close();
  rmSync(dir4, { recursive: true, force: true });
}

// --- a heartbeat that cannot be written revokes too ---------------------------
//
// "Unknown is not alive": a store that refuses the write is treated exactly
// like a lease that is gone, with the write failure as the reason.
{
  const dir5 = mkdtempSync(join(tmpdir(), "reeve-e2e-hbfail-"));
  const ctx5 = { ...baseCtx(), db: open(join(dir5, "h.db")), logPath: join(dir5, "log.txt"), heartbeatMs: 100,
                 worktreeFor: () => mkdtempSync(join(dir5, "wt-")),
                 heartbeat: () => { throw new Error("database is locked"); } };
  let sawRevoked = null;
  ctx5.spawnWorker = async (args) => {
    await new Promise(r => setTimeout(r, 400));
    sawRevoked = args.isRevoked?.();
    return { outcome: "lease_lost", why: `lease revoked: ${sawRevoked}`, ms: 400, cost: 0, sessionId: "s5" };
  };
  await tick(ctx5);
  check(typeof sawRevoked === "string" && /heartbeat write failed: database is locked/.test(sawRevoked),
    "a failed heartbeat write revokes with its own reason", String(sawRevoked));
  ctx5.db.close();
  rmSync(dir5, { recursive: true, force: true });
}


// --- a CLI whose version cannot be read is not dispatched --------------------
//
// The contract exists to record exactly which CLI ran. "unknown" is not a
// version; resolution happens with the worker's own binary, and a failure to
// resolve is a preparation failure: no launch, the run closed, the attempt refunded.
{
  const dir6 = mkdtempSync(join(tmpdir(), "reeve-e2e-cli-"));
  const ctx6 = { ...baseCtx(), db: open(join(dir6, "v.db")), logPath: join(dir6, "log.txt"), worktreeFor: () => mkdtempSync(join(dir6, "wt-")),
                 claudeBin: "/nonexistent/claude" };
  delete ctx6.cliVersion;
  let launched = 0;
  ctx6.spawnWorker = async () => { launched++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  await tick(ctx6);
  check(launched === 0, "no worker launches when the CLI version cannot be resolved", String(launched));
  const run6 = ctx6.db.prepare("SELECT status, error FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(run6?.status === "failed" && /cli version|claude/i.test(run6?.error ?? ""), "the run is closed with the reason", JSON.stringify(run6));
  check((ctx6.db.prepare("SELECT COALESCE(SUM(attempts),0) n FROM fix_attempt").get().n) === 0, "and the attempt is refunded", "");
  ctx6.db.close();
  rmSync(dir6, { recursive: true, force: true });
}

ctx.db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
