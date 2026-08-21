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
  const { WORKER_ACTIONS, UNBUILT_ACTIONS } = await import("../src/prompts.mjs");
  check(WORKER_ACTIONS.includes("SPILL") && WORKER_ACTIONS.includes("FIX_CI"), "control: the shared worker-action list names SPILL", WORKER_ACTIONS.join(","));
  // Actions whose prompts need GitHub effects a worker cannot perform (gh is
  // shimmed; effects are reeve's) are refused at the seam, not launched.
  const dsrc = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(UNBUILT_ACTIONS.REQUEST_REVIEW && UNBUILT_ACTIONS.SPILL, "REQUEST_REVIEW and SPILL are declared unbuilt with a reason", JSON.stringify(UNBUILT_ACTIONS));
  check(/UNBUILT_ACTIONS\[decision\.action\]/.test(dsrc), "and the daemon refuses them at dispatch", "");
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


// --- a cooperative cancel closes the run as abandoned, never as failed ------
{
  const dir7 = mkdtempSync(join(tmpdir(), "reeve-e2e-cancel-"));
  const ctx7 = { ...baseCtx(), db: open(join(dir7, "c.db")), logPath: join(dir7, "log.txt"), heartbeatMs: 100,
                 worktreeFor: () => mkdtempSync(join(dir7, "wt-")), heartbeat: () => ({ alive: false, reason: "cancelled" }) };
  ctx7.spawnWorker = async (args) => { await new Promise(r => setTimeout(r, 400)); const why = args.isRevoked?.(); return { outcome: why === "cancelled" ? "cancelled" : "ok", why: `lease revoked: ${why}`, ms: 400, cost: 0, sessionId: "s7" }; };
  await tick(ctx7);
  const run7 = ctx7.db.prepare("SELECT status FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(run7?.status === "abandoned", "a cancelled worker's run is abandoned, not failed", JSON.stringify(run7));
  const node7 = ctx7.db.prepare("SELECT status FROM node WHERE id='pr:42'").get();
  check(node7?.status !== "blocked", "and the PR node is not marked blocked by a cancellation", JSON.stringify(node7));
  ctx7.db.close();
  rmSync(dir7, { recursive: true, force: true });
}


// --- an OK worker whose lease lapsed while it ran is not accepted -----------
{
  const dir8 = mkdtempSync(join(tmpdir(), "reeve-e2e-lapsed-"));
  const ctx8 = { ...baseCtx(), db: open(join(dir8, "x.db")), logPath: join(dir8, "log.txt"), worktreeFor: () => mkdtempSync(join(dir8, "wt-")) };
  ctx8.spawnWorker = async () => {
    // The lease expires under the worker between heartbeats; the worker still
    // reports success.
    ctx8.db.prepare("UPDATE run SET lease_expires_at = unixepoch() - 5 WHERE status IN ('leased','running')").run();
    return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s8" };
  };
  await tick(ctx8);
  const run8 = ctx8.db.prepare("SELECT status FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(run8?.status !== "succeeded", "a worker that finished under a lapsed lease is not recorded as succeeded", JSON.stringify(run8));
  const log8 = readFileSync(join(dir8, "log.txt"), "utf8");
  check(/lease/.test(log8) && !/published/.test(log8), "the log names the lapsed lease and nothing was published", log8.split("\n").filter(l => /#42/.test(l)).slice(-3).join(" | ").slice(0, 300));
  ctx8.db.close();
  rmSync(dir8, { recursive: true, force: true });
}


// --- a persistent preparation failure backs off and is escalated once --------
{
  const dir9 = mkdtempSync(join(tmpdir(), "reeve-e2e-prep-"));
  const ctx9 = { ...baseCtx(), db: open(join(dir9, "p.db")), logPath: join(dir9, "log.txt"), worktreeFor: () => mkdtempSync(join(dir9, "wt-")),
                 claudeBin: "/nonexistent/claude" };
  delete ctx9.cliVersion;
  const r9a = await tick(ctx9);
  const r9b = await tick(ctx9);
  const runs = ctx9.db.prepare("SELECT COUNT(*) n FROM run").get().n;
  check(runs === 1, "a second tick during the backoff does not lease and fail the PR again", `runs=${runs}`);
  const keys = [...(r9b.escalations?.keys() ?? [])];
  check(keys.some(k => /could not be prepared/.test(k)) && !keys.some(k => /prepared.*\d{2,}/.test(k)), "and the failure stands as one escalation with an identity key", keys.join(" | "));
  ctx9.db.close();
  rmSync(dir9, { recursive: true, force: true });
}

// --- an UNBOUND worker refunds the attempt like any pre-execution failure ---
{
  const dir10 = mkdtempSync(join(tmpdir(), "reeve-e2e-unbound-"));
  const ctx10 = { ...baseCtx(), db: open(join(dir10, "u.db")), logPath: join(dir10, "log.txt"), worktreeFor: () => mkdtempSync(join(dir10, "wt-")) };
  ctx10.spawnWorker = async () => ({ outcome: "unbound", why: "run binding failed: x", ms: 1, cost: null, sessionId: null });
  await tick(ctx10);
  const spent = ctx10.db.prepare("SELECT COALESCE(SUM(attempts),0) n FROM fix_attempt").get().n;
  check(spent === 0, "no fixer ran, so no attempt is spent", String(spent));
  // A binding that keeps failing is a preparation failure: it backs off and
  // stands as one escalation, instead of leasing and refusing every tick.
  const r10b = await tick(ctx10);
  check(ctx10.db.prepare("SELECT COUNT(*) n FROM run").get().n === 1, "a second tick after an unbound launch stays in the backoff", String(ctx10.db.prepare("SELECT COUNT(*) n FROM run").get().n));
  check([...(r10b.escalations?.keys() ?? [])].some(k => /could not be prepared/.test(k)), "and the failure stands as the preparation escalation", [...(r10b.escalations?.keys() ?? [])].join(" | "));
  ctx10.db.close();
  rmSync(dir10, { recursive: true, force: true });
}


// --- a cancel before the binding is a cancellation, not a preparation failure
{
  const dir11 = mkdtempSync(join(tmpdir(), "reeve-e2e-prebind-"));
  const ctx11 = { ...baseCtx(), db: open(join(dir11, "b.db")), logPath: join(dir11, "log.txt"), worktreeFor: () => mkdtempSync(join(dir11, "wt-")) };
  ctx11.db.prepare("INSERT OR REPLACE INTO node (id, kind, title, status, created_at, updated_at) VALUES ('pr:42','pr','t','open',unixepoch(),unixepoch())").run();
  ctx11.db.prepare("INSERT OR REPLACE INTO task_exec (task_id, cancel_requested) VALUES ('pr:42', 1)").run();
  ctx11.spawnWorker = async (args) => {
    // What runWorker does: bind first; a refused binding is UNBOUND with the reason.
    try { args.onSpawn({ pid: 4321, lstart: "x" }); } catch (err) { return { outcome: "unbound", why: `run binding failed: ${err.message}`, ms: 0, cost: null, sessionId: null }; }
    return { outcome: "ok", why: "ran", ms: 1, cost: 0, sessionId: "s" };
  };
  const r11 = await tick(ctx11);
  const keys11 = [...(r11.escalations?.keys() ?? [])];
  check(!keys11.some(k => /could not be prepared/.test(k)), "a pre-bind cancellation raises no preparation escalation", keys11.join(" | "));
  const run11 = ctx11.db.prepare("SELECT status FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(run11?.status === "abandoned", "the run is abandoned as a cancellation", JSON.stringify(run11));
  // The audit trail must say cancellation too: classified before the run is
  // closed, so the store emits run.finish with outcome cancelled, not a
  // refusal of an unbound worker.
  const ev11 = ctx11.db.prepare("SELECT op, payload FROM event WHERE op IN ('run.finish','run.refused') ORDER BY seq DESC LIMIT 1").get();
  check(ev11?.op === "run.finish" && /"outcome":"cancelled"/.test(ev11?.payload ?? ""), "and the audit event records a cancelled finish, not an unbound refusal", JSON.stringify(ev11));
  let dispatchedAgain = 0;
  ctx11.spawnWorker = async () => { dispatchedAgain++; return { outcome: "ok", why: "ran", ms: 1, cost: 0, sessionId: "s" }; };
  await tick(ctx11);
  check(dispatchedAgain === 1, "and the next tick dispatches again with no backoff", String(dispatchedAgain));
  ctx11.db.close();
  rmSync(dir11, { recursive: true, force: true });
}

// --- a cancel after the binding is seen by the 2-second poll, not the next heartbeat
{
  const dir12 = mkdtempSync(join(tmpdir(), "reeve-e2e-postbind-"));
  const ctx12 = { ...baseCtx(), db: open(join(dir12, "c.db")), logPath: join(dir12, "log.txt"), worktreeFor: () => mkdtempSync(join(dir12, "wt-")), heartbeatMs: 3_600_000 };
  let seen = null;
  ctx12.spawnWorker = async (args) => {
    args.onSpawn({ pid: 4322, lstart: "x" });
    ctx12.db.prepare("INSERT OR REPLACE INTO task_exec (task_id, cancel_requested) VALUES ('pr:42', 1)").run();
    seen = args.isRevoked?.();
    return { outcome: "cancelled", why: `cancelled: ${seen}`, ms: 1, cost: 0, sessionId: "s" };
  };
  await tick(ctx12);
  check(typeof seen === "string" && /^cancelled/.test(seen), "a cancel requested after the binding is visible to the revocation poll before any heartbeat", String(seen));
  ctx12.db.close();
  rmSync(dir12, { recursive: true, force: true });
}

ctx.db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
