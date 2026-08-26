// The guardian's requests are served in order, and the canary asks first.
//
// `claimProvider` grants a guardian claim only when no OLDER guardian request is
// queued. The tick asks for the containment canary before anything else, so the
// moment a worker request is queued the canary is refused for ever -- and that
// refusal sets `skipDispatch`, which stops the per-decision loop, which is the
// only thing that would have re-asked for the worker. Neither moves again, and
// `queuedGuardianCount` blocks every BUILDER admission behind two requests
// nobody will serve.
//
// Driven through the REAL scheduler rather than a stub: the ordering rule is
// what is under test, and a fake would have whatever ordering I gave it.
import { openHub } from "../src/build/hubdb.mjs";
import { claimProvider, releaseProvider, queuedGuardianRequests } from "../src/provider.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-qorder-"));
const alive = () => true;
const NWO = "o/r", WORKER = "o/r#42:FIX_CI", CANARY = "canary:o/r";

const store = (name, limit) => {
  const db = openHub(join(dir, name));
  db.prepare(`INSERT INTO provider_state(provider,concurrency_limit,guardian_reserved,measured_at)
              VALUES('claude',?,0,unixepoch())`).run(limit);
  return db;
};
const claim = (db, runRef) => claimProvider(db, { owner: "guardian", repoId: 1, runRef, pid: 1, lstart: "L", isAlive: alive });
const release = (db, runRef, got) => releaseProvider(db, {
  id: got.id, token: got.token, owner: "guardian", repoId: 1, runRef, isAlive: alive });

// ── the deadlock is real, and this is the fixture that shows it ───────────
// One slot. The canary takes it, the worker queues behind it, the canary
// releases at the end of its tick. From the next tick on, the canary asks first
// and is never the oldest.
{
  const db = store("deadlock.db", 1);
  const c1 = claim(db, CANARY);
  check(c1.ok, "fixture: the canary is granted the only slot on the first tick", JSON.stringify(c1));
  const w1 = claim(db, WORKER);
  check(w1.ok === false && w1.reason === "queued",
    "fixture: the worker queues behind it", JSON.stringify(w1));
  check(release(db, CANARY, c1).ok, "fixture: and the canary releases at the end of that tick");

  // Four more ticks of the canary asking first, with nothing re-asking for the
  // worker. This is the shape the daemon had.
  const refusals = [];
  for (let t = 0; t < 4; t++) refusals.push(claim(db, CANARY).reason ?? "granted");
  check(refusals.every(r => r === "queued"),
    "the canary is refused on EVERY later tick, because the worker is older",
    JSON.stringify(refusals));
  check(queuedGuardianRequests(db, { repoId: 1 }).length > 0,
    "and the queue never empties, so builder admission stays blocked",
    JSON.stringify(queuedGuardianRequests(db, { repoId: 1 }).map(r => r.run_ref)));
  db.close();
}

// ── serving the queue head is what breaks it ──────────────────────────────
// The tick re-asks for the oldest request it still wants, ahead of the canary,
// and releases it — granting is what removes it from the queue.
{
  const db = store("served.db", 1);
  const c1 = claim(db, CANARY);
  claim(db, WORKER);                       // queues
  release(db, CANARY, c1);

  // The repair, as the tick performs it: serve the head, then ask for the canary.
  const head = queuedGuardianRequests(db, { repoId: 1 }).find(r => r.run_ref !== CANARY);
  check(head?.run_ref === WORKER, "the queue head is the worker request", JSON.stringify(head?.run_ref));
  const served = claim(db, head.run_ref);
  check(served.ok, "re-asking for the head promotes it", JSON.stringify(served));
  check(release(db, head.run_ref, served).ok, "and releasing it empties the queue");
  check(queuedGuardianRequests(db, { repoId: 1 }).length === 0,
    "the queue is empty", JSON.stringify(queuedGuardianRequests(db, { repoId: 1 })));

  const c2 = claim(db, CANARY);
  check(c2.ok, "so the canary is granted on the next tick and containment can be measured",
    JSON.stringify(c2));
  db.close();
}

// ── and the DAEMON does it, on a real hub ─────────────────────────────────
// The block above proves the scheduler's ordering and the shape of the repair.
// It does not prove the tick performs it: a structural check that the source
// mentions the repair passes with the repair disabled, which a stub loop showed
// -- disabling it left every assertion green because the log string survived.
// So this drives a whole tick against a real hub and asks whether the queue
// actually drained.
{
  const { tick } = await import("../src/daemon.mjs");
  const { openHubAsGuest } = await import("../src/build/hubguest.mjs");
  const { open } = await import("../src/db/ops.mjs");
  const d2 = mkdtempSync(join(tmpdir(), "reeve-qorder-tick-"));
  const hubPath = join(d2, "hub.db");
  const db = store("tick-hub.db", 1);
  db.close();
  const { copyFileSync } = await import("node:fs");
  copyFileSync(join(dir, "tick-hub.db"), hubPath);

  // The deadlocked state, built with the real scheduler: a worker request
  // queued, nothing holding.
  const owner = openHub(hubPath);
  const c = claimProvider(owner, { owner: "guardian", repoId: 1, runRef: CANARY, pid: 1, lstart: "L", isAlive: alive });
  claimProvider(owner, { owner: "guardian", repoId: 1, runRef: WORKER, pid: 1, lstart: "L", isAlive: alive });
  releaseProvider(owner, { id: c.id, token: c.token, owner: "guardian", repoId: 1, runRef: CANARY, isAlive: alive });
  const before = queuedGuardianRequests(owner, { repoId: 1 }).map(r => r.run_ref);
  owner.close();
  check(before.includes(WORKER),
    "fixture: the hub starts with the worker request queued and nothing held", JSON.stringify(before));

  const guest = openHubAsGuest(hubPath);
  const ctx = {
    nwo: NWO, db: open(join(d2, "s.db")), logPath: join(d2, "log.txt"),
    execute: true, shadow: true, running: 0,
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: NWO, defaultBranch: "main", worktreeRoot: d2, checkout: mkdtempSync(join(tmpdir(), "reeve-qorder-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
      worker: { isolation: "none" },   // the cheap gates answer without a canary process
    },
    hub: () => ({ hub: guest, why: null }), repoId: 1, lstart: "L",
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => ({
      ok: true, pr: 42, state: "open", head: "b".repeat(40), title: "t", headRef: "mp/bt-1-s0", baseRef: "main",
      verdict: { state: "BLOCK", summary: "ci is red", clauses: [
        { id: "mergeable", state: "PASS", detail: "clean" }, { id: "base", state: "PASS", detail: "green" },
        { id: "ci", state: "BLOCK", detail: "failing: unit" }, { id: "review", state: "PASS", detail: "n/a" },
        { id: "threads", state: "PASS", detail: "none" }, { id: "rounds", state: "PASS", detail: "0" },
        { id: "findings", state: "PASS", detail: "none" }] },
      rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
      checks: { verdict: "RED", caused: ["unit"], failing: [{ name: "unit", id: 1 }] },
      reviewers: [], threads: {}, settled: { settled: true },
    }),
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: d2, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx);
  ctx.db.close();
  try { guest.close(); } catch {}

  const after = (() => { const o = openHub(hubPath);
    try { return queuedGuardianRequests(o, { repoId: 1 }).map(r => r.run_ref); } finally { o.close(); } })();
  check(!after.includes(WORKER),
    "one tick drains the queued worker request, so the canary is not blocked behind it for ever",
    JSON.stringify({ before, after }));
  rmSync(d2, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
