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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

ctx.db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
