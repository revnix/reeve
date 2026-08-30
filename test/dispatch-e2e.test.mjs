// The dispatch path had NO test, because driving it needs GitHub and a live
// `claude`. A ReferenceError sat in it undetected as a result: `cause` and `fp`
// were declared inside the per-PR loop and read from the dispatch loop, a
// separate block, so every FIX_CI would have thrown the moment --execute was on.
// The unit tests around it were all green.
//
// This drives a whole tick with the collaborators stubbed, which is the
// integration the audit named as missing: daemon -> durable run -> worker ->
// finish, and the refusal to re-dispatch work already in flight.
import { tick, stateRootsFor } from "../src/daemon.mjs";
import { open, liveRunFor, countFixAttempts, recordFixAttempt } from "../src/db/ops.mjs";
import { causeKey } from "../src/ci-rootcause.mjs";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "reeve-e2e-"));
// The clone and the worktree root are separate directories, as a real
// deployment must have them: the worker policy denies reads of the clone, so a
// checkout INSIDE it would be denied its own code and the dispatch refuses.
const clone = mkdtempSync(join(tmpdir(), "reeve-e2e-clone-"));
// A real repository with a LOCAL identity. reeve reads user.name/user.email from
// the founder's checkout to commit a worker's work, and a fixture that fell
// through to the developer's global config would pass here and fail on a machine
// that has none.
execFileSync("git", ["-C", clone, "init", "-q"]);
execFileSync("git", ["-C", clone, "config", "user.name", "Founder"]);
execFileSync("git", ["-C", clone, "config", "user.email", "founder@example.invalid"]);
const dbPath = join(dir, "e.db");
const logPath = join(dir, "log.txt");
import { fingerprint } from "../src/checkout.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const HEAD = "a".repeat(40);
const CAUSE = { ok: true, job: "CI Gate", step: "Test",
                cause: [{ where: "src/x.ts:1", message: "boom" }] };

const profile = {
  identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: clone },
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
  // Deterministic: the real capacity() backs off on the host's load average, so
  // a busy machine would fail these assertions for a reason that is not the code.
  capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
  // The tests below exercise dispatch, so they declare what the real module
  // cannot yet: a closed credential read. The default refuses; see the last case.
  containment: { credentialRead: "closed", why: "test" },
  // The per-spawn revalidation re-probes the keychain; injected clean here so
  // the default-closed cases dispatch. Cases that test an open verdict override.
  keychain: { measured: true, items: [], why: null },
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
  // `observe` reaches the network too, and unstubbed it was the single largest
  // cost in this suite: four `gh api` round trips per tick against `o/r`, which
  // does not exist, so every one waited for a 404. Measured on this file plus
  // guardian-provider-lease: 321s unstubbed against 17s stubbed, with PASS and
  // FAIL output byte-identical either way.
  //
  // The value is what the real call ALREADY returns here, not a success: with
  // every request failing, `observe` reports the read incomplete and the thread
  // count unreadable. Returning `ok: true` would be a different test -- the fold
  // treats a complete read and a partial one differently, and a stub that
  // quietly upgrades the answer is how a suite starts agreeing with itself
  // rather than with the product.
  observe: () => ({ ok: false, observations: [], incomplete: true,
                    threads: { readable: false, total: null, unresolved: 0, seen: 0 } }),
  // Injected, never read from disk. The real reader looks at
  // ~/.reeve/claude-token, so a default makes these tests pass on a machine that
  // happens to have one and fail on CI, which is exactly what it did.
  oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
  prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
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
                 prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir3, "wt-")), why: null, deps: { ok: true, cow: false } }) };
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


// --- containment is MEASURED, and an open verdict refuses dispatch ----------
//
// The verdict comes from containment.mjs: the sandbox canary must pass and the
// login keychain must hold no GitHub credential. The measurement's two inputs
// are injected here (ctx.canary, ctx.keychain); the wiring from verdict to
// dispatch is what this case proves. A daemon started with --execute must not
// launch a worker that can read the founder's token; it says so, once, as an
// identity.
{
  const dir4 = mkdtempSync(join(tmpdir(), "reeve-e2e-contain-"));
  const ctx4 = { ...baseCtx(), db: open(join(dir4, "c.db")), logPath: join(dir4, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir4, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 // No cheaper reason, so the canary is the gate that runs and fails:
                 // measured platform, an isolated (verified) worker, an empty keychain.
                 platform: "darwin",
                 profile: { ...profile, worker: { isolation: "scratch-home" } },
                 isolationReady: () => true,
                 canary: async () => ({ ok: false, id: "planted", why: "planted: wrote outside the worktree", evidence: {} }),
                 keychain: { measured: true, items: [], why: null } };
  delete ctx4.containment;          // measured, not declared
  let launched = 0;
  ctx4.spawnWorker = async () => { launched++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const r4 = await tick(ctx4);
  check(launched === 0, "no worker launches while the measured containment is open (canary failed)", String(launched));
  const keys = [...(r4.escalations?.keys() ?? [])];
  check(keys.includes("guardian:containment:open"), "and the refusal is a standing escalation with an identity key", keys.join(" | "));
  check(!/open \d|\d+ worker/.test(keys.join(" ")), "the key carries no counts", keys.join(" | "));
  const log4 = readFileSync(join(dir4, "log.txt"), "utf8");
  check(/NOT dispatching/.test(log4) && /canary planted failed: planted: wrote outside/.test(log4), "the log names the measured reason", log4.split("\n").filter(l => /dispatch/.test(l)).join(" | ").slice(0, 300));
  check(existsSync(join(dir4, "canary", "o", "r.json")) && JSON.parse(readFileSync(join(dir4, "canary", "o", "r.json"), "utf8")).ok === false,
    "and the canary's result is persisted for the doctor", "");
  // Every action promptFor can dispatch is a worker task, SPILL included; the
  // refusal must count them from one shared list, not a hand-copied subset.
  const { WORKER_ACTIONS, UNBUILT_ACTIONS } = await import("../src/prompts.mjs");
  check(WORKER_ACTIONS.includes("SPILL") && WORKER_ACTIONS.includes("FIX_CI"), "control: the shared worker-action list names SPILL", WORKER_ACTIONS.join(","));
  // Actions whose prompts need GitHub effects a worker cannot perform (gh is
  // shimmed; effects are reeve's) are refused at the seam, not launched.
  const dsrc = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(UNBUILT_ACTIONS.REQUEST_REVIEW, "REQUEST_REVIEW is declared unbuilt with a reason", JSON.stringify(UNBUILT_ACTIONS));
  // SPILL LEFT THIS LIST when reeve began performing it: the daemon enqueues the
  // issue, the replies and the resolves itself rather than asking a worker. Asserted
  // as an ABSENCE with its reason rather than deleted, because a line quietly removed
  // is indistinguishable from one nobody replaced -- and the pairing with
  // REQUEST_REVIEW above is what shows the list still has entries and the check has
  // not simply been switched off.
  check(!UNBUILT_ACTIONS.SPILL, "and SPILL has left it, because reeve performs that effect now", JSON.stringify(UNBUILT_ACTIONS));
  check(/spillEffects\(\{/.test(dsrc),
    "control: the daemon really does produce the spill's effects, so the absence above is wiring and not a deletion");
  check(/UNBUILT_ACTIONS\[decision\.action\]/.test(dsrc), "and the daemon refuses them at dispatch", "");
  check(/WORKER_ACTIONS\.includes\(d\.decision\.action\)/.test(dsrc), "and the containment refusal filters by that list", "");
  ctx4.db.close();
  rmSync(dir4, { recursive: true, force: true });
}

// --- a GitHub credential in the keychain keeps it open whatever the canary said
{
  const dirK = mkdtempSync(join(tmpdir(), "reeve-e2e-keychain-"));
  const ctxK = { ...baseCtx(), db: open(join(dirK, "k.db")), logPath: join(dirK, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirK, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 // The ONLY variable under test is the host keychain, so the
                 // isolation is declared and the canary passes.
                 platform: "darwin", profile: { ...profile, worker: { isolation: "scratch-home" } },
                 canary: async () => ({ ok: true, id: "good", why: null, evidence: {} }),
                 keychain: { measured: true, items: ["generic password gh:github.com (gh keyring)"], why: "the login keychain holds: generic password gh:github.com (gh keyring)" } };
  delete ctxK.containment;
  let launchedK = 0;
  ctxK.spawnWorker = async () => { launchedK++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const rK = await tick(ctxK);
  // CHANGED 2026-08-22: the host's keychain no longer gates, because a worker
  // has no login keychain in its search list. What gates is the canary, which
  // measures that reach — so this case now proves the REPLACEMENT property.
  check(launchedK === 1, "the founder's keychain contents no longer block dispatch on their own", String(launchedK));
  ctxK.db.close();
  rmSync(dirK, { recursive: true, force: true });
}
{
  // ... and a canary that DID reach the keychain still refuses, which is the
  // property that actually protects the credential.
  const dirKC = mkdtempSync(join(tmpdir(), "reeve-e2e-kcreach-"));
  const ctxKC = { ...baseCtx(), db: open(join(dirKC, "k.db")), logPath: join(dirKC, "log.txt"),
                  prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirKC, "wt-")), why: null, deps: { ok: true, cow: false } }),
                  platform: "darwin", profile: { ...profile, worker: { isolation: "scratch-home" } },
                  canary: async () => ({ ok: false, id: "kc", why: "read the founder's GitHub credential from the keychain", evidence: {} }),
                  keychain: { measured: true, items: [], why: null } };
  delete ctxKC.containment;
  let launchedKC = 0;
  ctxKC.spawnWorker = async () => { launchedKC++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const rKC = await tick(ctxKC);
  check(launchedKC === 0 && [...rKC.escalations.keys()].includes("guardian:containment:open"),
    "a canary that reached the keychain refuses every dispatch", String(launchedKC));
  check(/keychain/.test(readFileSync(join(dirKC, "log.txt"), "utf8")), "and the log names it", "");
  ctxKC.db.close();
  rmSync(dirKC, { recursive: true, force: true });
}

// --- measured closed: the canary passed, the keychain is empty, a worker runs
//
// The positive control for the two refusals above, and the proof that the
// measurement is wired to dispatch rather than beside it. The canary runs
// ONCE per (CLI, block): a second tick under the same daemon context does not
// run it again.
{
  const dirC = mkdtempSync(join(tmpdir(), "reeve-e2e-closed-"));
  let canaryRuns = 0;
  const ctxC = { ...baseCtx(), db: open(join(dirC, "c.db")), logPath: join(dirC, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirC, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 // Forced so the case runs the same on every CI OS: it tests the
                 // canary+keychain wiring, not the per-OS platform gate (that is
                 // its own case below).
                 platform: "darwin",
                 // A declared isolated worker AND a verified-ready topology are
                 // required to close dispatch; this is the positive control.
                 profile: { ...profile, worker: { isolation: "scratch-home" } },
                 isolationReady: () => true,
                 canary: async () => { canaryRuns++; return { ok: true, id: "good", why: null, evidence: {} }; },
                 keychain: { measured: true, items: [], why: null } };
  delete ctxC.containment;
  let launchedC = 0;
  ctxC.spawnWorker = async () => { launchedC++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const rC = await tick(ctxC);
  check(launchedC === 1, "measured closed: a worker is dispatched", String(launchedC));
  check(![...rC.escalations.keys()].includes("guardian:containment:open"), "and no containment escalation stands", [...rC.escalations.keys()].join(" | "));
  check(canaryRuns === 1, "the canary ran exactly once", String(canaryRuns));
  const stateC = JSON.parse(readFileSync(join(dirC, "canary", "o", "r.json"), "utf8"));
  check(stateC.ok === true && stateC.id === "good", "the passing result is persisted", JSON.stringify(stateC));
  await tick(ctxC);
  check(canaryRuns === 1, "a second tick reuses the passing canary", String(canaryRuns));
  ctxC.db.close();
  rmSync(dirC, { recursive: true, force: true });
}

// --- the database and a relative log are protected state, not blind spots -----
{
  // [7] --db can point anywhere; the store holds the event history and prompts.
  const withDb = stateRootsFor("/s", "/s/reeve.log", "/wt", "/elsewhere/state.db");
  check(withDb.includes("/elsewhere/state.db") && withDb.includes("/elsewhere/state.db-wal") && withDb.includes("/elsewhere/state.db-shm"),
    "the selected database and its WAL/shm files are protected state", JSON.stringify(withDb));
  // [1] a relative --log used to drop EVERY state deny, because they are filtered
  // to absolute paths, and hand the worker relative run paths besides.
  const rel = stateRootsFor("/s", "reeve.log", "/wt", null);
  check(!rel.some(p => !p.startsWith("/")), "no relative path survives into the deny list", JSON.stringify(rel));
}

// --- a worker that changed its checkout's git config is not read from ---------
//
// core.fsmonitor names a program git RUNS, and the daemon's `git status` is
// unsandboxed. Nothing is read and nothing is published from such a worktree.
{
  const dirG = mkdtempSync(join(tmpdir(), "reeve-e2e-cfgtamper-"));
  const ctxG = { ...baseCtx(), db: open(join(dirG, "g.db")), logPath: join(dirG, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirG, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: false, why: "planted: the worker changed the repository's git configuration" }) };
  let pushedG = 0;
  ctxG.spawnWorker = async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" });
  const rG = await tick(ctxG);
  const logG = readFileSync(join(dirG, "log.txt"), "utf8");
  check(/NOT reading or publishing this checkout/.test(logG), "the tick refuses to read or publish that checkout", logG.split("\n").filter(l => /#42/.test(l)).slice(-2).join(" | ").slice(0, 200));
  check(!/published/.test(logG) && pushedG === 0, "nothing is published", "");
  check([...rG.escalations.keys()].includes("guardian:checkout:config-tampered"), "and it escalates under an identity key", [...rG.escalations.keys()].join(" | "));
  ctxG.db.close();
  rmSync(dirG, { recursive: true, force: true });
}

// --- a checkout that could not be built is reeve's failure, not the worker's --
//
// Preparation happens INSIDE the dispatch try-block, so a failure there leaves
// the path null while everything below it still runs. The configuration check
// reads a null path as "no recorded configuration", which is a refusal -- and it
// was reported as the worker having tampered with git config. That accuses a
// worker that never started, on the most ordinary failure there is (no disk, no
// token, a clone that would not clone), and it fires the tamper channel every
// time it happens.
{
  const dirF = mkdtempSync(join(tmpdir(), "reeve-e2e-prepfail-"));
  const ctxF = { ...baseCtx(), db: open(join(dirF, "f.db")), logPath: join(dirF, "log.txt"),
                 prepareCheckout: () => ({ ok: false, path: null, why: "no space left on device" }) };
  let spawnedF = 0;
  ctxF.spawnWorker = async () => { spawnedF++; return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; };
  const rF = await tick(ctxF);
  const escF = [...rF.escalations.keys()].join(" | ");
  const logF = readFileSync(join(dirF, "log.txt"), "utf8");

  // The precondition: dispatch was REACHED. Without this the case would pass by
  // never getting that far, which is how a refund test proved nothing before.
  const runF = ctxF.db.prepare("SELECT status, task_id FROM run ORDER BY started_at DESC LIMIT 1").get();
  check(runF?.task_id === "pr:42", "control: dispatch was reached and a run was created", JSON.stringify(runF));
  check(spawnedF === 0, "control: no worker was launched without a checkout", `spawned=${spawnedF}`);
  check(/could not be prepared/i.test(escF), "it is reported as a preparation failure", escF);
  check(!/tamper/i.test(escF) && !/git configuration/i.test(escF),
    "and NOT as the worker changing the checkout's git configuration", escF);
  check(!/NOT reading or publishing/.test(logF),
    "the log does not claim there was a checkout to read",
    logF.split("\n").filter(l => /NOT reading/.test(l)).join(" | "));
  check(countFixAttempts(ctxF.db, "o/r", 42, causeKey("o/r", CAUSE)) === 0,
    "and the fixer's attempt is refunded, because nothing ran",
    String(countFixAttempts(ctxF.db, "o/r", 42, causeKey("o/r", CAUSE))));
  ctxF.db.close();
  rmSync(dirF, { recursive: true, force: true });
}

// --- a finished worker that never committed keeps its work ------------------
//
// reeve publishes by fetching the checkout's BRANCH, so an uncommitted edit
// cannot travel with the push. changedFiles counts it anyway (deliberately: a
// worker that stops part-way has still done something), so the diff gate passed,
// the log said "published N file(s)", and the release then DELETED the only copy.
{
  const dirU = mkdtempSync(join(tmpdir(), "reeve-e2e-uncommitted-"));
  const wtU = mkdtempSync(join(dirU, "wt-"));
  // A checkout with an edit the worker never committed.
  execFileSync("git", ["-C", wtU, "init", "-q"]);
  writeFileSync(join(wtU, "fix.js"), "the fix nobody committed\n");
  let publishedU = 0;
  const ctxU = { ...baseCtx(), db: open(join(dirU, "u.db")), logPath: join(dirU, "log.txt"),
                 prepareCheckout: () => ({ ok: true, path: wtU, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedU++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
  const rU = await tick(ctxU);
  const logU = readFileSync(join(dirU, "log.txt"), "utf8");
  const escU = [...rU.escalations.keys()].join(" | ");

  check(publishedU === 0, "a checkout with uncommitted work on ANOTHER branch is NOT published", `published=${publishedU}`);
  check(!/published \d+ file/.test(logU), "and the log does not say it was", logU.split("\n").filter(l => /publish/.test(l)).join(" | ").slice(0, 200));
  check(/uncommitted/.test(escU), "the escalation says what is wrong with it", escU);
  check(existsSync(join(`${wtU}.unfetched`, "fix.js")) || existsSync(join(wtU, "fix.js")),
    "and the work still exists somewhere on disk", `${wtU}`);
  ctxU.db.close();
  rmSync(dirU, { recursive: true, force: true });
  rmSync(`${wtU}.unfetched`, { recursive: true, force: true });
}

// --- reeve COMMITS what the worker could not, and then publishes it ----------
//
// The worker's sandbox denies Bash writes to `.git`, so `git add` and
// `git commit` fail with EPERM on `.git/index.lock`. Measured 2026-08-23: three
// dispatches, three correct fixes, nothing published, because the fix only ever
// existed in the working tree. reeve commits before the gates, and the gates then
// judge the ref that results.
{
  const dirV = mkdtempSync(join(tmpdir(), "reeve-e2e-reeve-commits-"));
  const wtV = mkdtempSync(join(dirV, "wt-"));
  execFileSync("git", ["-C", wtV, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtV, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wtV, "add", "-A"]);
  execFileSync("git", ["-C", wtV, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinnedV = execFileSync("git", ["-C", wtV, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // What a worker leaves behind now: the fix, in the files, uncommitted. Plus a
  // file git is told to ignore, which must not travel.
  writeFileSync(join(wtV, ".gitignore"), "ignored.log\n");
  writeFileSync(join(wtV, "fix.js"), "the fix the worker could not commit\n");
  writeFileSync(join(wtV, "ignored.log"), "build noise\n");
  // And a dependency tree the DAEMON copied in, which this repository does not
  // ignore. It must not be staged into the repair -- and, having been excluded,
  // must not then make the checkout look dirty and quarantine the whole thing.
  mkdirSync(join(wtV, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(wtV, "node_modules", "pkg", "index.js"), "vendored\n");

  let publishedV = 0, atPublish = null;
  const ctxV = { ...baseCtx(), db: open(join(dirV, "v.db")), logPath: join(dirV, "log.txt"),
                 // Declared so `dependencyPathsFor` yields node_modules, which is
                 // what the daemon copies in and must exclude on both sides.
                 profile: { ...profile, units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm" }] },
                 evaluate: () => ({ ...evaluation, head: pinnedV, headRef: "f" }),
                 // The BASELINE: what preparation itself left untracked. Reeve
                 // subtracts exactly these, so a file it did not put there is the
                 // worker's however deep inside a copied tree it sits.
                 prepareCheckout: () => ({ ok: true, path: wtV, why: null,
                                           deps: { ok: true, cow: false, copied: ["node_modules"],
                                                   untracked: fingerprint(wtV, ["node_modules/pkg/index.js"]) } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 // Read at the moment reeve considers the work publishable: a
                 // successful publish releases the checkout, so nothing can be
                 // inspected after the tick returns.
                 publishWork: ({ path }) => {
                   publishedV++;
                   const gv = (...a) => execFileSync("git", ["-C", path, ...a], { encoding: "utf8" }).trim();
                   atPublish = { head: gv("rev-parse", "f"),
                                 // Excluding what the daemon copied in: the
                                 // invariant is that nothing the WORKER did is
                                 // dropped, not that the directory is pristine.
                                 dirty: gv("status", "--porcelain", "--", ".", ":(exclude)node_modules"),
                                 leftover: gv("status", "--porcelain"),
                                 shipped: gv("diff", "--name-only", `${pinnedV}..refs/heads/f`).split("\n").filter(Boolean),
                                 who: gv("log", "-1", "--format=%an <%ae>"),
                                 subject: gv("log", "-1", "--format=%s"), body: gv("log", "-1", "--format=%b") };
                   return { ok: true, why: null };
                 },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s",
                                             report: { fixed: true, cause: "the day was read in local time",
                                                       change: "use the UTC accessors",
                                                       filesTouched: [".gitignore", "fix.js"] } }) };
  const rV = await tick(ctxV);
  const escV = [...rV.escalations.keys()].join(" | ");
  check(atPublish !== null, "control: reeve reached the publish step at all", escV);
  // Every assertion below is conditioned on having reached it. Without that, a
  // run that never publishes leaves these undefined and `undefined !== pinned`
  // reads as a pass -- the check would be green precisely when the fix is gone.
  const at = atPublish ?? {};
  const reached = atPublish !== null;
  const shipped = at.shipped ?? [];

  check(reached && at.head !== pinnedV, "reeve commits the work the worker left in the files", `${pinnedV.slice(0, 8)} -> ${String(at.head ?? "(never published)").slice(0, 8)}`);
  check(reached && publishedV === 1, "and publishes it", `published=${publishedV} esc=${escV}`);
  check(reached && at.dirty === "", "leaving nothing of the worker's uncommitted, so nothing is silently dropped", String(at.dirty ?? "(never published)"));
  check(reached && /node_modules/.test(at.leftover ?? ""), "control: the dependency tree really was still sitting there untracked", String(at.leftover ?? "(never published)").slice(0, 120));
  check(reached && shipped.includes("fix.js"), "the fix travels", shipped.join(", ") || "(never published)");
  check(reached && !shipped.includes("ignored.log"), "an ignored file does not", shipped.join(", ") || "(never published)");
  check(reached && !shipped.some(f => f.startsWith("node_modules/")), "and neither does the dependency tree reeve copied in", shipped.join(", ") || "(never published)");

  // The commit must carry the FOUNDER's identity. With GIT_CONFIG_GLOBAL at
  // /dev/null a worker checkout has none, and git invents one from the username
  // and the hostname -- an address nobody owns, which a ruleset requiring a
  // verified committer refuses.
  check(reached && at.who === "Founder <founder@example.invalid>", "under the founder's identity, not one git invented", String(at.who ?? "(never published)"));

  // And the message is reeve's, built from the worker's own two sentences.
  check(reached && at.subject === "fix(ci): use the UTC accessors", "the subject is Conventional Commits, from the report's `change`", String(at.subject ?? "(never published)"));
  check(reached && at.body === "the day was read in local time", "and the body is the report's `cause`", String(at.body ?? "(never published)"));
  check(reached && String(at.subject ?? "x".repeat(99)).length <= 72, "control: the subject fits the 72-character limit", String((at.subject ?? "").length));

  ctxV.db.close();
  rmSync(dirV, { recursive: true, force: true });
}

// --- an UNDECLARED file inside a copied tree is still the worker's ------------
//
// Every path-exclusion shape hid this: `:(exclude)<tree>` dropped the tree
// entirely, and `--untracked-files=no` inside it dropped exactly the new files.
// So a worker could declare and commit `fix.js`, leave an undeclared
// `vendor/patch.js`, and reeve would publish the incomplete repair and then
// delete the only copy of the omitted part. The baseline recorded at prepare time
// is what separates reeve's own files from the worker's.
{
  const dirB = mkdtempSync(join(tmpdir(), "reeve-e2e-baseline-"));
  const wtB = mkdtempSync(join(dirB, "wt-"));
  execFileSync("git", ["-C", wtB, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtB, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wtB, "add", "-A"]);
  execFileSync("git", ["-C", wtB, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinnedB = execFileSync("git", ["-C", wtB, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Preparation copied `vendor/dep.js` in, and the repository does not ignore it.
  mkdirSync(join(wtB, "vendor"), { recursive: true });
  writeFileSync(join(wtB, "vendor", "dep.js"), "copied in by the daemon\n");
  // The worker's work: one declared file, and one it did NOT declare, sitting
  // inside that same tree where every exclusion shape lost it.
  writeFileSync(join(wtB, "fix.js"), "the declared part\n");
  writeFileSync(join(wtB, "vendor", "patch.js"), "the part it did not report\n");

  let publishedB = 0;
  const ctxB = { ...baseCtx(), db: open(join(dirB, "b.db")), logPath: join(dirB, "log.txt"),
                 profile: { ...profile, worker: { dependencyPaths: ["vendor"] },
                            units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm" }] },
                 evaluate: () => ({ ...evaluation, head: pinnedB, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtB, why: null,
                                           deps: { ok: true, cow: false, copied: ["vendor"],
                                                   untracked: fingerprint(wtB, ["vendor/dep.js"]) } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedB++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s",
                                             report: { fixed: true, cause: "c", change: "ch",
                                                       filesTouched: ["fix.js"] } }) };
  const rB = await tick(ctxB);
  const escB = [...rB.escalations.keys()].join(" | ");
  const keptB = existsSync(`${wtB}.unfetched`) ? `${wtB}.unfetched` : existsSync(wtB) ? wtB : null;

  check(publishedB === 0, "an undeclared file inside a copied tree stops the publication", `published=${publishedB} esc=${escB}`);
  check(/uncommitted/.test(escB), "and the escalation says what is wrong", escB);
  check(!!keptB && existsSync(join(keptB, "vendor", "patch.js")), "and the omitted part is kept, not deleted with the checkout", String(keptB));
  ctxB.db.close();
  rmSync(dirB, { recursive: true, force: true });
  rmSync(`${wtB}.unfetched`, { recursive: true, force: true });
}

// --- a DELETED file reeve copied is the worker's too --------------------------
//
// Deleting an untracked file produces no status record at all -- there is nothing
// left for git to report -- so a per-status check never sees it. A worker that
// removes a dependency file its fix depended on would leave the checkout reading
// clean, and the source half would publish without it.
{
  const dirD = mkdtempSync(join(tmpdir(), "reeve-e2e-deleted-copy-"));
  const wtD = mkdtempSync(join(dirD, "wt-"));
  execFileSync("git", ["-C", wtD, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtD, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wtD, "add", "-A"]);
  execFileSync("git", ["-C", wtD, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinnedD = execFileSync("git", ["-C", wtD, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  mkdirSync(join(wtD, "vendor"), { recursive: true });
  writeFileSync(join(wtD, "vendor", "dep.js"), "as the daemon copied it\n");
  const baseD = fingerprint(wtD, ["vendor/dep.js"]);
  // The worker deletes that copy and declares only its source change.
  rmSync(join(wtD, "vendor", "dep.js"));
  writeFileSync(join(wtD, "fix.js"), "the declared companion\n");
  check(execFileSync("git", ["-C", wtD, "status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" })
          .split("\n").filter(l => /vendor/.test(l)).length === 0,
    "control: git reports NOTHING for the deleted untracked file", "");

  let publishedD = 0;
  const ctxD = { ...baseCtx(), db: open(join(dirD, "d.db")), logPath: join(dirD, "log.txt"),
                 profile: { ...profile, worker: { dependencyPaths: ["vendor"] },
                            units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm" }] },
                 evaluate: () => ({ ...evaluation, head: pinnedD, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtD, why: null,
                                           deps: { ok: true, cow: false, copied: ["vendor"], untracked: baseD } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedD++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s",
                                             report: { fixed: true, cause: "c", change: "ch", filesTouched: ["fix.js"] } }) };
  const rD = await tick(ctxD);
  const escD = [...rD.escalations.keys()].join(" | ");
  check(publishedD === 0, "a DELETED file reeve copied stops the publication", `published=${publishedD} esc=${escD}`);
  check(/vendor\/dep\.js/.test(escD), "and the escalation names it", escD);
  ctxD.db.close();
  rmSync(dirD, { recursive: true, force: true });
  rmSync(`${wtD}.unfetched`, { recursive: true, force: true });
}

// --- an EDIT to a file reeve copied is the worker's too -----------------------
//
// git reports an edited copy exactly as it reports an untouched one -- the same
// `?? vendor/dep.js` -- so a baseline of PATHNAMES subtracted the worker's edit
// and an incomplete repair published: the tests passed only with the omitted
// dependency patch, and the checkout carrying it was then deleted. The digest is
// what separates them.
{
  const dirE = mkdtempSync(join(tmpdir(), "reeve-e2e-edited-copy-"));
  const wtE = mkdtempSync(join(dirE, "wt-"));
  execFileSync("git", ["-C", wtE, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtE, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wtE, "add", "-A"]);
  execFileSync("git", ["-C", wtE, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinnedE = execFileSync("git", ["-C", wtE, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  mkdirSync(join(wtE, "vendor"), { recursive: true });
  writeFileSync(join(wtE, "vendor", "dep.js"), "as the daemon copied it\n");
  // The baseline is taken HERE, exactly as preparation would take it.
  const baseE = fingerprint(wtE, ["vendor/dep.js"]);
  // Now the worker patches that copy and does not declare it.
  writeFileSync(join(wtE, "vendor", "dep.js"), "patched by the worker\n");
  writeFileSync(join(wtE, "fix.js"), "the declared companion\n");

  let publishedE = 0;
  const ctxE = { ...baseCtx(), db: open(join(dirE, "e.db")), logPath: join(dirE, "log.txt"),
                 profile: { ...profile, worker: { dependencyPaths: ["vendor"] },
                            units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm" }] },
                 evaluate: () => ({ ...evaluation, head: pinnedE, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtE, why: null,
                                           deps: { ok: true, cow: false, copied: ["vendor"], untracked: baseE } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedE++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s",
                                             report: { fixed: true, cause: "c", change: "ch", filesTouched: ["fix.js"] } }) };
  const rE = await tick(ctxE);
  const escE = [...rE.escalations.keys()].join(" | ");
  const keptE = existsSync(`${wtE}.unfetched`) ? `${wtE}.unfetched` : existsSync(wtE) ? wtE : null;

  check(publishedE === 0, "an EDIT to a file reeve copied stops the publication", `published=${publishedE} esc=${escE}`);
  check(!!keptE && readFileSync(join(keptE, "vendor", "dep.js"), "utf8").includes("patched by the worker"),
    "and the patch is kept, not deleted with the checkout", String(keptE));
  ctxE.db.close();
  rmSync(dirE, { recursive: true, force: true });
  rmSync(`${wtE}.unfetched`, { recursive: true, force: true });
}

// --- a DECLARED dependency path that was never copied is the worker's ---------
//
// Preparation skips a declared dependency path that does not exist in the
// founder's checkout. Excluding the DECLARED list rather than what was actually
// copied would then hide the worker's own creation of that path from staging and
// from the uncommitted check at once: the rest of the fix ships and that part is
// deleted with the checkout, silently.
{
  const dirP = mkdtempSync(join(tmpdir(), "reeve-e2e-declared-dep-"));
  const wtP = mkdtempSync(join(dirP, "wt-"));
  execFileSync("git", ["-C", wtP, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtP, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wtP, "add", "-A"]);
  execFileSync("git", ["-C", wtP, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinnedP = execFileSync("git", ["-C", wtP, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // The fix creates the very path the profile declares as a dependency tree --
  // which preparation found nothing to copy for.
  mkdirSync(join(wtP, "vendor"), { recursive: true });
  writeFileSync(join(wtP, "vendor", "patch.js"), "the part of the fix that lives here\n");
  writeFileSync(join(wtP, "fix.js"), "the rest of it\n");

  let publishedP = 0, atP = null;
  const ctxP = { ...baseCtx(), db: open(join(dirP, "p.db")), logPath: join(dirP, "log.txt"),
                 profile: { ...profile, worker: { dependencyPaths: ["vendor"] },
                            units: [{ id: "root", root: ".", language: "typescript", packageManager: "npm" }] },
                 evaluate: () => ({ ...evaluation, head: pinnedP, headRef: "f" }),
                 // Declared "vendor", copied NOTHING: it did not exist to copy.
                 prepareCheckout: () => ({ ok: true, path: wtP, why: null, deps: { ok: true, cow: false, copied: [] } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: ({ path }) => {
                   publishedP++;
                   atP = execFileSync("git", ["-C", path, "diff", "--name-only", `${pinnedP}..refs/heads/f`], { encoding: "utf8" }).trim().split("\n").filter(Boolean);
                   return { ok: true, why: null };
                 },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s",
                                             report: { fixed: true, cause: "c", change: "ch",
                                                       filesTouched: ["fix.js", "vendor/patch.js"] } }) };
  const rP = await tick(ctxP);
  const escP = [...rP.escalations.keys()].join(" | ");

  check(publishedP === 1, "a fix that creates a declared-but-uncopied path is published", `published=${publishedP} esc=${escP}`);
  check((atP ?? []).includes("vendor/patch.js"), "and that part of it travels rather than being dropped", (atP ?? ["(never published)"]).join(", "));
  check((atP ?? []).includes("fix.js"), "control: so does the rest", (atP ?? ["(never published)"]).join(", "));
  ctxP.db.close();
  rmSync(dirP, { recursive: true, force: true });
  rmSync(`${wtP}.unfetched`, { recursive: true, force: true });
}

// --- a report that does not account for the checkout is not a repair ---------
//
// The diff gate judges paths and territory, never intent, so a reproduction
// script inside the lane passes it and would be published as part of the fix.
// Only the worker knows which of its files were the repair, so a disagreement
// between what it reported and what it left is the check.
//
// The absent and malformed report cases are the same rule read the other way: a
// run that says nothing has not said it fixed anything.
for (const [what, report, commits] of [
  // The declared part DOES commit here: staging from the declaration means the
  // undeclared file is never staged, and what refuses is the uncommitted-work
  // gate on exactly what is left. Nothing publishes either way.
  ["an undeclared scratch file", { fixed: true, cause: "c", change: "ch", filesTouched: ["fix.js"] }, true],
  ["no report at all", null, false],
  ["a report with no `fixed`", { cause: "c", change: "ch", filesTouched: ["fix.js", "repro.js"] }, false],
  // An unusable `filesTouched` is refused before any staging happens at all.
  ["no filesTouched at all", { fixed: true, cause: "c", change: "ch" }, false],
  ["a filesTouched that is not an array", { fixed: true, cause: "c", change: "ch", filesTouched: "fix.js" }, false],
]) {
  const dirU2 = mkdtempSync(join(tmpdir(), "reeve-e2e-undeclared-"));
  const wtU2 = mkdtempSync(join(dirU2, "wt-"));
  execFileSync("git", ["-C", wtU2, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtU2, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wtU2, "add", "-A"]);
  execFileSync("git", ["-C", wtU2, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinnedU2 = execFileSync("git", ["-C", wtU2, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // The fix, and beside it a reproduction script the worker did not declare.
  writeFileSync(join(wtU2, "fix.js"), "the fix\n");
  writeFileSync(join(wtU2, "repro.js"), "console.log('reproducing')\n");

  let publishedU2 = 0;
  const ctxU2 = { ...baseCtx(), db: open(join(dirU2, "u2.db")), logPath: join(dirU2, "log.txt"),
                  evaluate: () => ({ ...evaluation, head: pinnedU2, headRef: "f" }),
                  prepareCheckout: () => ({ ok: true, path: wtU2, why: null, deps: { ok: true, cow: false, copied: [] } }),
                  verifyConfig: () => ({ ok: true, why: null }),
                  publishWork: () => { publishedU2++; return { ok: true, why: null }; },
                  spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", report }) };
  const rU2 = await tick(ctxU2);
  const escU2 = [...rU2.escalations.keys()].join(" | ");
  // Whichever path survived: a refusal quarantines, and a publish would have
  // released the checkout entirely. Read defensively so a regression FAILS here
  // rather than throwing and taking the rest of the file with it.
  const keptAt = existsSync(`${wtU2}.unfetched`) ? `${wtU2}.unfetched` : existsSync(wtU2) ? wtU2 : null;
  const movedU2 = keptAt
    ? execFileSync("git", ["-C", keptAt, "rev-parse", "f"], { encoding: "utf8" }).trim()
    : null;

  check(publishedU2 === 0, `${what}: nothing is published`, `published=${publishedU2} esc=${escU2}`);
  check(commits ? movedU2 !== pinnedU2 : movedU2 === pinnedU2,
    commits ? "the declared part is committed, and held back rather than shipped" : "and nothing was committed either",
    `${pinnedU2.slice(0, 8)} vs ${String(movedU2 ?? "(checkout gone)").slice(0, 8)}`);
  check(!!keptAt && existsSync(join(keptAt, "repro.js")), "the work is kept for a human", String(keptAt));
  ctxU2.db.close();
  rmSync(dirU2, { recursive: true, force: true });
  rmSync(`${wtU2}.unfetched`, { recursive: true, force: true });
}

// --- a worker that DECLINES must not have its exploration published ----------
//
// `classifyResult` judges the process, so a run that reports `fixed: false`
// still arrives as OK -- and the output contract calls that a good outcome.
// Before reeve committed, the uncommitted-work gate stopped those edits. If reeve
// commits first, a declared non-fix becomes a publishable repair.
for (const [what, report] of [
  ["fixed: false", { fixed: false, cause: "could not reproduce it", change: "nothing" }],
  ["needsHuman", { fixed: true, needsHuman: "this needs a schema migration", cause: "c", change: "ch" }],
]) {
  const dirD = mkdtempSync(join(tmpdir(), "reeve-e2e-declined-"));
  const wtD = mkdtempSync(join(dirD, "wt-"));
  execFileSync("git", ["-C", wtD, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtD, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wtD, "add", "-A"]);
  execFileSync("git", ["-C", wtD, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinnedD = execFileSync("git", ["-C", wtD, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // What it leaves behind while deciding it cannot finish.
  writeFileSync(join(wtD, "explored.js"), "half an idea\n");

  let publishedD = 0;
  const ctxD = { ...baseCtx(), db: open(join(dirD, "d.db")), logPath: join(dirD, "log.txt"),
                 evaluate: () => ({ ...evaluation, head: pinnedD, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtD, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedD++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s", report }) };
  const rD = await tick(ctxD);
  const escD = [...rD.escalations.keys()].join(" | ");
  const kept = existsSync(join(`${wtD}.unfetched`, "explored.js")) || existsSync(join(wtD, "explored.js"));

  check(publishedD === 0, `a worker reporting ${what} publishes nothing`, `published=${publishedD} esc=${escD}`);
  check(kept, "and its exploration is kept rather than deleted", `${wtD}`);
  ctxD.db.close();
  rmSync(dirD, { recursive: true, force: true });
  rmSync(`${wtD}.unfetched`, { recursive: true, force: true });
}

// --- a token in the COMMIT MESSAGE travels with the push too -----------------
//
// The first version of this check ran `git diff`, which emits the file patch and
// not commit metadata — so a worker that put the credential in its commit
// message had it pushed into public history by a check that had just declared
// the change clean.
{
  const dirT = mkdtempSync(join(tmpdir(), "reeve-e2e-msgtoken-"));
  const wtT = mkdtempSync(join(dirT, "wt-"));
  const TOKEN = "sk-ant-oat01-test-token-not-a-real-credential";
  const gT = (...a) => execFileSync("git", ["-C", wtT, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", wtT, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtT, "a.txt"), "base\n");
  gT("add", "-A"); gT("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const baseSha = gT("rev-parse", "HEAD");
  // An innocuous source change, and the credential in the message.
  writeFileSync(join(wtT, "a.txt"), "fixed\n");
  gT("add", "-A"); gT("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", `fix: it works\n\ndebug ${TOKEN}`);

  let publishedT = 0;
  const evalT = { ...evaluation, head: baseSha, headRef: "f" };
  const ctxT = { ...baseCtx(), db: open(join(dirT, "t.db")), logPath: join(dirT, "log.txt"),
                 evaluate: () => evalT,
                 prepareCheckout: () => ({ ok: true, path: wtT, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedT++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
  const rT = await tick(ctxT);
  const escT = [...rT.escalations.keys()].join(" | ");
  check(publishedT === 0, "a commit MESSAGE carrying reeve's token is not published", `published=${publishedT}`);
  // NAMED, not merely refused. The first version of this passed because the
  // check could not read the diff at all and refused everything, which is a
  // different fact wearing the same result.
  check(/carries reeve's worker authentication token/.test(escT),
    "and the reason names the credential, rather than a check that could not run", escT);
  check(!escT.includes(TOKEN), "without ever printing the credential", "the escalation contained it");
  ctxT.db.close();
  rmSync(dirT, { recursive: true, force: true });
  rmSync(`${wtT}.unfetched`, { recursive: true, force: true });

  // THE CONTROL. A check that refuses everything also refuses the leak, and
  // looks identical from the outside. This is the assertion that would have
  // caught it: an ordinary change, no credential anywhere, must publish.
  const dirC = mkdtempSync(join(tmpdir(), "reeve-e2e-cleanpub-"));
  const wtC = mkdtempSync(join(dirC, "wt-"));
  const gC = (...a) => execFileSync("git", ["-C", wtC, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", wtC, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtC, "a.txt"), "base\n");
  gC("add", "-A"); gC("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const baseC = gC("rev-parse", "HEAD");
  writeFileSync(join(wtC, "a.txt"), "an ordinary fix\n");
  gC("add", "-A"); gC("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fix: nothing secret here");
  let publishedC = 0;
  const ctxC = { ...baseCtx(), db: open(join(dirC, "c.db")), logPath: join(dirC, "log.txt"),
                 evaluate: () => ({ ...evaluation, head: baseC, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtC, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedC++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
  await tick(ctxC);
  check(publishedC === 1, "control: a change carrying no credential still publishes", `published=${publishedC}`);
  ctxC.db.close();
  rmSync(dirC, { recursive: true, force: true });
}

// --- an unfinished worker's commit lives on the BRANCH, not at HEAD ----------
//
// A worker that commits on the PR branch and then checks out the pinned commit
// leaves HEAD exactly where it started. changedFiles compares HEAD, saw nothing,
// and the release deleted the standalone clone — the only copy of the commit.
{
  const dirB = mkdtempSync(join(tmpdir(), "reeve-e2e-branchwork-"));
  const wtB = mkdtempSync(join(dirB, "wt-"));
  const gB = (...a) => execFileSync("git", ["-C", wtB, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", wtB, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtB, "a.txt"), "base\n");
  gB("add", "-A"); gB("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const pinned = gB("rev-parse", "HEAD");
  writeFileSync(join(wtB, "a.txt"), "a candidate fix\n");
  gB("add", "-A"); gB("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "the worker's commit");
  const workSha = gB("rev-parse", "HEAD");
  gB("checkout", "-q", pinned);            // detached, exactly where it started
  check(gB("rev-parse", "HEAD") === pinned, "control: HEAD is back at the pinned commit", "");
  check(gB("rev-parse", "refs/heads/f") === workSha, "control: and the work is on the branch", "");

  const evalB = { ...evaluation, head: pinned, headRef: "f" };
  const ctxB = { ...baseCtx(), db: open(join(dirB, "b.db")), logPath: join(dirB, "log.txt"),
                 evaluate: () => evalB,
                 prepareCheckout: () => ({ ok: true, path: wtB, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 spawnWorker: async () => ({ outcome: "failed", why: "turn limit", ms: 1, cost: 0, sessionId: "s" }) };
  await tick(ctxB);
  check(!existsSync(wtB), "control: the checkout was released from its original path", "");
  check(existsSync(join(`${wtB}.unfetched`, ".git")), "an unfinished worker's commit is PRESERVED, not deleted with the clone", `${wtB}.unfetched`);
  ctxB.db.close();
  rmSync(dirB, { recursive: true, force: true });
  rmSync(`${wtB}.unfetched`, { recursive: true, force: true });
}

// --- the gates judge the ref that gets PUSHED, not HEAD ----------------------
//
// publishRunWork pushes `e.headRef`. A worker can commit anything on that
// branch, then check out an auxiliary branch carrying an allowed change: every
// gate read HEAD, passed, and the push carried content none of them looked at.
// Both commits descend from the pinned head, so nothing else noticed.
{
  const dirA = mkdtempSync(join(tmpdir(), "reeve-e2e-auxbranch-"));
  const wtA = mkdtempSync(join(dirA, "wt-"));
  const gA = (...a) => execFileSync("git", ["-C", wtA, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", wtA, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtA, "a.txt"), "base\n");
  gA("add", "-A"); gA("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const pinned = gA("rev-parse", "HEAD");
  // On the PR branch: the change reeve must judge.
  writeFileSync(join(wtA, "forbidden.txt"), "the content no gate looked at\n");
  gA("add", "-A"); gA("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "on the branch that gets pushed");
  // Then an auxiliary branch from the SAME pinned head, with an allowed change.
  gA("checkout", "-q", "-b", "aux", pinned);
  writeFileSync(join(wtA, "innocuous.txt"), "nothing to see\n");
  gA("add", "-A"); gA("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "what the gates would see");
  check(gA("rev-parse", "--abbrev-ref", "HEAD") === "aux", "control: the worker left HEAD on the auxiliary branch", "");

  // The credential check reads the same range the gate does, so planting the
  // token on the PR branch makes the answer unambiguous: refused means the
  // branch was read, published means only the auxiliary HEAD was.
  const TOKEN_A = "sk-ant-oat01-test-token-not-a-real-credential";
  gA("checkout", "-q", "f");
  writeFileSync(join(wtA, "forbidden.txt"), `the content no gate looked at\n${TOKEN_A}\n`);
  gA("add", "-A"); gA("-c", "user.email=w@w", "-c", "user.name=w", "commit", "--amend", "-qm", "on the branch that gets pushed");
  gA("checkout", "-q", "aux");
  check(gA("rev-parse", "--abbrev-ref", "HEAD") === "aux", "control: HEAD is still the auxiliary branch", "");

  let publishedA = 0;
  const ctxA = { ...baseCtx(), db: open(join(dirA, "a.db")), logPath: join(dirA, "log.txt"),
                 evaluate: () => ({ ...evaluation, head: pinned, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtA, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedA++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
  const rA = await tick(ctxA);
  const escA = [...rA.escalations.keys()].join(" | ");
  check(publishedA === 0, "the branch that will be PUSHED is what the gates read, not the auxiliary HEAD", `published=${publishedA}`);
  check(/carries reeve's worker authentication token/.test(escA),
    "so content only reachable from that branch is judged", escA);
  ctxA.db.close();
  rmSync(dirA, { recursive: true, force: true });
  rmSync(`${wtA}.unfetched`, { recursive: true, force: true });
}

// --- a secret committed then deleted still travels with the push ------------
//
// `git diff <since>..<ref>` is the NET patch. A worker that committed the token
// and removed it in a later commit left a clean net diff, and the push carried
// the intermediate commit and its blob.
{
  const dirS = mkdtempSync(join(tmpdir(), "reeve-e2e-deletedsecret-"));
  const wtS = mkdtempSync(join(dirS, "wt-"));
  const TOKEN = "sk-ant-oat01-test-token-not-a-real-credential";
  const gS = (...a) => execFileSync("git", ["-C", wtS, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", wtS, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtS, "a.txt"), "base\n");
  gS("add", "-A"); gS("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const pinned = gS("rev-parse", "HEAD");
  writeFileSync(join(wtS, "leak.txt"), `${TOKEN}\n`);
  gS("add", "-A"); gS("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "oops");
  rmSync(join(wtS, "leak.txt"));
  writeFileSync(join(wtS, "a.txt"), "an ordinary fix\n");
  gS("add", "-A"); gS("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "fix: tidy up");
  const net = execFileSync("git", ["-C", wtS, "diff", "--no-ext-diff", `${pinned}..HEAD`], { encoding: "utf8" });
  check(!net.includes(TOKEN), "control: the NET patch is clean — this is why the old check passed", "");

  let publishedS = 0;
  const ctxS = { ...baseCtx(), db: open(join(dirS, "s.db")), logPath: join(dirS, "log.txt"),
                 evaluate: () => ({ ...evaluation, head: pinned, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtS, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedS++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
  const rS = await tick(ctxS);
  const escS = [...rS.escalations.keys()].join(" | ");
  check(publishedS === 0, "a secret in an intermediate commit is caught, though the net patch is clean", `published=${publishedS}`);
  check(/carries reeve's worker authentication token/.test(escS), "and named as the credential it is", escS);
  ctxS.db.close();
  rmSync(dirS, { recursive: true, force: true });
  rmSync(`${wtS}.unfetched`, { recursive: true, force: true });
}

// --- a credential inside a BINARY blob, and one that straddles a read --------
//
// The two cases the object walk exists for, and neither had a test.
//
// MEASURED: a blob containing NUL bytes does not appear in a patch at all —
// `git diff` prints "Binary files ... differ" — so the old patch-based check
// could not have seen it however carefully it read. And the scan reads the
// object stream in windows, so a value split across a read boundary is only
// found because an overlap is carried forward; without one it would be missed
// silently, which is the worst way for a credential check to fail.
{
  const dirB = mkdtempSync(join(tmpdir(), "reeve-e2e-binblob-"));
  const wtB = mkdtempSync(join(dirB, "wt-"));
  const TOKEN = "sk-ant-oat01-test-token-not-a-real-credential";
  const gB = (...a) => execFileSync("git", ["-C", wtB, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", wtB, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtB, "a.txt"), "base\n");
  gB("add", "-A"); gB("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const pinned = gB("rev-parse", "HEAD");

  // Binary, and large enough that the token lands well past the first read.
  const blob = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.alloc(3 * 1024 * 1024, 0x41),
                              Buffer.from(TOKEN), Buffer.alloc(3 * 1024 * 1024, 0x42), Buffer.from([0])]);
  writeFileSync(join(wtB, "asset.bin"), blob);
  gB("add", "-A"); gB("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "feat: add an asset");

  // The control that says why the object walk exists at all.
  const patch = execFileSync("git", ["-C", wtB, "diff", "--no-ext-diff", `${pinned}..HEAD`],
                             { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  check(!patch.includes(TOKEN) && /Binary files/.test(patch),
    "control: the token is invisible to a patch — git only says the binary files differ", patch.split("\n").filter(l => /Binary/.test(l)).join(" "));

  let publishedB = 0;
  const ctxB = { ...baseCtx(), db: open(join(dirB, "b.db")), logPath: join(dirB, "log.txt"),
                 evaluate: () => ({ ...evaluation, head: pinned, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtB, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedB++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
  const rB = await tick(ctxB);
  const escB = [...rB.escalations.keys()].join(" | ");
  check(publishedB === 0, "a credential buried in a multi-megabyte BINARY blob is caught", `published=${publishedB}`);
  check(/carries reeve's worker authentication token/.test(escB), "and named as the credential it is", escB);
  check(!escB.includes(TOKEN), "without ever printing it", "the escalation contained it");
  ctxB.db.close();
  rmSync(dirB, { recursive: true, force: true });
  rmSync(`${wtB}.unfetched`, { recursive: true, force: true });
}

// --- a path touched and RESTORED still reaches the gate ----------------------
//
// `git diff --name-only <since>..<ref>` names what the DIFF contains, not what
// each commit touched. A worker that edited a forbidden path in one commit and
// put it back in a later one showed NOTHING at the endpoints — while the push
// still carried that commit and its objects, and the diff gate had approved it.
{
  const dirP = mkdtempSync(join(tmpdir(), "reeve-e2e-restored-"));
  const wtP = mkdtempSync(join(dirP, "wt-"));
  const gP = (...a) => execFileSync("git", ["-C", wtP, ...a], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", wtP, "init", "-q", "-b", "f"]);
  mkdirSync(join(wtP, ".github", "workflows"), { recursive: true });
  writeFileSync(join(wtP, ".github", "workflows", "ci.yml"), "name: CI\n");
  writeFileSync(join(wtP, "app.js"), "console.log(1)\n");
  gP("add", "-A"); gP("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  const pinned = gP("rev-parse", "HEAD");

  // The gate that judges the work is SELF_GOVERNING on .github/** — a worker
  // editing the thing that grades it is the case reviewDiff exists for.
  writeFileSync(join(wtP, ".github", "workflows", "ci.yml"), "name: CI\n# quietly weakened\n");
  gP("add", "-A"); gP("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "touch the gate");
  writeFileSync(join(wtP, ".github", "workflows", "ci.yml"), "name: CI\n");   // put it back
  gP("add", "-A"); gP("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "restore it");
  writeFileSync(join(wtP, "app.js"), "console.log(2)\n");
  gP("add", "-A"); gP("-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "fix: the allowed change");

  // The control that says why the per-commit walk exists at all.
  const endpoints = execFileSync("git", ["-C", wtP, "diff", "--no-ext-diff", "--name-only", `${pinned}..HEAD`], { encoding: "utf8" }).trim();
  check(!/\.github/.test(endpoints) && /app\.js/.test(endpoints),
    "control: the endpoint diff shows only the allowed change — the gate saw nothing wrong", JSON.stringify(endpoints));

  let publishedP = 0;
  const ctxP = { ...baseCtx(), db: open(join(dirP, "p.db")), logPath: join(dirP, "log.txt"),
                 evaluate: () => ({ ...evaluation, head: pinned, headRef: "f" }),
                 prepareCheckout: () => ({ ok: true, path: wtP, why: null, deps: { ok: true, cow: false } }),
                 verifyConfig: () => ({ ok: true, why: null }),
                 publishWork: () => { publishedP++; return { ok: true, why: null }; },
                 spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
  const rP = await tick(ctxP);
  const escP = [...rP.escalations.keys()].join(" | ");
  check(publishedP === 0, "a path touched and restored mid-range is still judged, and refused", `published=${publishedP}`);
  check(/\.github/.test(escP) || /refused publication/.test(escP), "and the reason names it", escP);
  ctxP.db.close();
  rmSync(dirP, { recursive: true, force: true });
  rmSync(`${wtP}.unfetched`, { recursive: true, force: true });
}

// --- a path git would QUOTE is still judged ----------------------------------
//
// git's default output quotes any path holding a non-ASCII byte or a newline:
// `secrets/kéy.txt` arrives as `"secrets/k\303\251y.txt"`. The leading quote
// means the risk globs stop matching, so a sensitive path published itself by
// being named in a language with accents. A rename had the same shape of hole
// from the other side: the "old -> new" parser kept only the destination, so
// renaming a secret to a harmless name showed the harmless name alone.
{
  const dirQ = mkdtempSync(join(tmpdir(), "reeve-e2e-quoted-"));
  const riskProfile = { ...profile, risk: { sensitivePaths: ["secrets/**"] } };
  const commitQ = (wt, msg) => {
    execFileSync("git", ["-C", wt, "add", "-A"], { encoding: "utf8" });
    execFileSync("git", ["-C", wt, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", msg], { encoding: "utf8" });
  };
  const seed = wt => {
    execFileSync("git", ["-C", wt, "init", "-q", "-b", "f"]);
    mkdirSync(join(wt, "secrets"), { recursive: true });
    writeFileSync(join(wt, "secrets", "key.txt"), "shhh\n");
    writeFileSync(join(wt, "app.js"), "console.log(1)\n");
    commitQ(wt, "base");
    return execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  };
  const runTick = async (wt, pinned, tag) => {
    let published = 0;
    const c = { ...baseCtx(), profile: riskProfile, db: open(join(dirQ, `${tag}.db`)), logPath: join(dirQ, `${tag}.txt`),
                evaluate: () => ({ ...evaluation, head: pinned, headRef: "f" }),
                prepareCheckout: () => ({ ok: true, path: wt, why: null, deps: { ok: true, cow: false } }),
                verifyConfig: () => ({ ok: true, why: null }),
                publishWork: () => { published++; return { ok: true, why: null }; },
                spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
    const r = await tick(c);
    c.db.close();
    return { published, why: [...r.escalations.keys()].join(" | ") };
  };

  // 1. a committed sensitive path whose name git quotes
  const wtQ = mkdtempSync(join(dirQ, "wt-"));
  const pinnedQ = seed(wtQ);
  writeFileSync(join(wtQ, "secrets", "kéy.txt"), "stolen\n");
  commitQ(wtQ, "add a secret with an accent in its name");
  const quoted = execFileSync("git", ["-C", wtQ, "log", "--name-only", "--pretty=format:", "-1"], { encoding: "utf8" }).trim();
  check(quoted.startsWith('"'),
    "control: git quotes the path, so a line-split reader never sees secrets/", JSON.stringify(quoted));
  const q = await runTick(wtQ, pinnedQ, "q");
  check(q.published === 0, "a sensitive path git would quote is still judged, and refused", `published=${q.published}`);
  check(/sensitive path/.test(q.why), "and the reason names it as sensitive", q.why);

  // 2. a COMMITTED rename that moves a sensitive file to a harmless name. Rename
  //    detection is on by default, and it collapses the pair to the destination.
  const wtR = mkdtempSync(join(dirQ, "wt-"));
  const pinnedR = seed(wtR);
  execFileSync("git", ["-C", wtR, "mv", join("secrets", "key.txt"), "public.txt"], { encoding: "utf8" });
  commitQ(wtR, "move it somewhere harmless");
  const detected = execFileSync("git", ["-C", wtR, "log", "--name-only", "--pretty=format:", "-1"], { encoding: "utf8" }).trim();
  check(detected === "public.txt",
    "control: rename detection reports the destination alone, so secrets/ vanishes", JSON.stringify(detected));
  const rn = await runTick(wtR, pinnedR, "r");
  check(rn.published === 0, "a rename's SOURCE is judged, not only where it landed", `published=${rn.published}`);
  check(/sensitive path/.test(rn.why), "and the reason names the path it came from", rn.why);

  // 3. a pathname that FORGES A LOG LINE. git allows a newline in a filename,
  //    and reading pathnames verbatim removed the escaping git's quoted form had
  //    been doing by accident. The name reaches reviewDiff's reason, the reason
  //    reaches the operational log, and a newline in it writes a line of the
  //    pull request's choosing under reeve's name.
  const wtF = mkdtempSync(join(dirQ, "wt-"));
  const pinnedF = seed(wtF);
  const forged = "secrets/x\nFORGED CLEARED: nothing needs you";
  writeFileSync(join(wtF, forged), "gotcha\n");
  commitQ(wtF, "a file whose name is a log line");
  const named = execFileSync("git", ["-C", wtF, "log", "--name-only", "--pretty=format:", "-z", "-1"], { encoding: "utf8" });
  check(named.includes(forged), "control: the pathname carries its newline all the way through git", JSON.stringify(named.slice(0, 90)));

  const f = await runTick(wtF, pinnedF, "f");
  check(f.published === 0, "a pathname that forges a log line is still judged, and refused", `published=${f.published}`);

  const written = readFileSync(join(dirQ, "f.txt"), "utf8");
  // The control first: a test that the log holds no forged line passes trivially
  // if the refusal never reached the log at all.
  check(/secrets\/x/.test(written), "control: the refusal naming that path really did reach the log", written.slice(-160));
  const orphans = written.split("\n").filter(l => l && !/^\d{4}-\d\d-\d\dT/.test(l));
  check(orphans.length === 0, "and every line in the log still starts with reeve's own timestamp", orphans.join(" | ").slice(0, 200));
  check(/FORGED CLEARED/.test(written) === false || /\\nFORGED/.test(written),
    "the forged text survives only as escaped text on reeve's own line", written.slice(-160));

  rmSync(dirQ, { recursive: true, force: true });
  rmSync(`${wtQ}.unfetched`, { recursive: true, force: true });
  rmSync(`${wtR}.unfetched`, { recursive: true, force: true });
  rmSync(`${wtF}.unfetched`, { recursive: true, force: true });
}

// --- an UNREADABLE range is not an empty one --------------------------------
//
// `run` returns null when git could not be asked, and `?? ""` turned that into
// an empty path list — so a completed fix that could not be READ was refused
// with "the worker produced an empty diff, nothing was changed". That reason is
// not true, and it sends whoever reads it to look at the worker rather than at
// the read. Two ways the read fails: a revision the checkout does not have, and
// output past execFileSync's buffer.
{
  const dirU = mkdtempSync(join(tmpdir(), "reeve-e2e-unreadable-"));
  const runTickU = async (wt, since, tag) => {
    let published = 0;
    const c = { ...baseCtx(), db: open(join(dirU, `${tag}.db`)), logPath: join(dirU, `${tag}.txt`),
                evaluate: () => ({ ...evaluation, head: since, headRef: "f" }),
                prepareCheckout: () => ({ ok: true, path: wt, why: null, deps: { ok: true, cow: false } }),
                verifyConfig: () => ({ ok: true, why: null }),
                publishWork: () => { published++; return { ok: true, why: null }; },
                spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }) };
    const r = await tick(c);
    c.db.close();
    return { published, why: [...r.escalations.keys()].join(" | ") };
  };

  // 1. a pinned revision the checkout does not hold, so `git log` refuses it
  const wtU = mkdtempSync(join(dirU, "wt-"));
  execFileSync("git", ["-C", wtU, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtU, "app.js"), "console.log(1)\n");
  execFileSync("git", ["-C", wtU, "add", "-A"]);
  execFileSync("git", ["-C", wtU, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "base"]);
  const absent = "0".repeat(39) + "1";
  let bad = "";
  try { execFileSync("git", ["-C", wtU, "log", "--name-only", `${absent}..HEAD`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { bad = String(e.stderr || e.message); }
  check(/bad revision|unknown revision|invalid revision|not a valid/i.test(bad),
    "control: git refuses the range, so the walk cannot be read at all", JSON.stringify(bad.slice(0, 90)));

  const u = await runTickU(wtU, absent, "u");
  check(u.published === 0, "a range that cannot be read is refused", `published=${u.published}`);
  check(/could not read/.test(u.why) && !/empty diff/.test(u.why),
    "and it is reported as unreadable, NOT as an empty diff", u.why);

  // 2. more pathnames than execFileSync's 1 MiB default will carry. ONE deep
  //    directory holding many files, rather than many deep directories: the
  //    pathname is repeated per file either way, and this builds in a fraction
  //    of a second where the other shape cost a minute.
  const wtB = mkdtempSync(join(dirU, "wt-"));
  execFileSync("git", ["-C", wtB, "init", "-q", "-b", "f"]);
  writeFileSync(join(wtB, "app.js"), "console.log(1)\n");
  execFileSync("git", ["-C", wtB, "add", "-A"]);
  execFileSync("git", ["-C", wtB, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "base"]);
  const pinnedB = execFileSync("git", ["-C", wtB, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const pad = "x".repeat(240);
  const wide = join(wtB, `a${pad}`, `b${pad}`, `c${pad}`);
  mkdirSync(wide, { recursive: true });
  for (let i = 0; i < 1600; i++) writeFileSync(join(wide, `f${String(i).padStart(4, "0")}.txt`), "x\n");
  // The path the gate must still see, buried in the pile.
  mkdirSync(join(wtB, ".github", "workflows"), { recursive: true });
  writeFileSync(join(wtB, ".github", "workflows", "ci.yml"), "name: CI\n");
  execFileSync("git", ["-C", wtB, "add", "-A"]);
  execFileSync("git", ["-C", wtB, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "a very wide change"]);
  const walked = execFileSync("git", ["-C", wtB, "log", "--name-only", "--no-renames", "--pretty=format:", "-m", "-z", `${pinnedB}..HEAD`],
                              { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).length;
  check(walked > 1024 * 1024,
    "control: the walk is past the 1 MiB execFileSync carries by default", `${walked} bytes`);

  const b = await runTickU(wtB, pinnedB, "b");
  check(b.published === 0, "a change wider than the default buffer is still judged", `published=${b.published}`);
  check(/\.github/.test(b.why), "and the gate saw the path buried in it", b.why.slice(0, 160));

  rmSync(dirU, { recursive: true, force: true });
  rmSync(`${wtU}.unfetched`, { recursive: true, force: true });
  rmSync(`${wtB}.unfetched`, { recursive: true, force: true });
}

// --- an already-open verdict prepares nothing (no canary litter per tick) -----
//
// With the default worker.isolation: none the canary can never run, so building
// its per-invocation tmp tree would litter the worktree root on every tick with
// directories nothing ever cleans up. (Codex #4e-[9].)
{
  const dirN = mkdtempSync(join(tmpdir(), "reeve-e2e-nolitter-"));
  const wtRoot = mkdtempSync(join(tmpdir(), "reeve-e2e-wtroot-"));
  const ctxN = { ...baseCtx(), db: open(join(dirN, "n.db")), logPath: join(dirN, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirN, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 platform: "darwin",
                 profile: { ...profile, identity: { ...profile.identity, worktreeRoot: wtRoot } },
                 keychain: { measured: true, items: [], why: null } };   // isolation stays "none" -> already open
  delete ctxN.containment;
  let launchedN = 0, canaryRunsN = 0;
  ctxN.canary = async () => { canaryRunsN++; return { ok: true, id: "x", why: null, evidence: {} }; };
  ctxN.spawnWorker = async () => { launchedN++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  await tick(ctxN);
  check(launchedN === 0 && canaryRunsN === 0, "an already-open verdict runs no canary at all", `launched=${launchedN} canary=${canaryRunsN}`);
  check(!existsSync(join(wtRoot, ".reeve-canary")), "and leaves no canary working directories behind", readdirSync(wtRoot).join(","));
  ctxN.db.close();
  rmSync(dirN, { recursive: true, force: true }); rmSync(wtRoot, { recursive: true, force: true });
}

// --- the isolation LABEL alone does not close: the topology must be verified ---
//
// worker.isolation=dedicated-user with an un-built topology (the daemon still
// runs a linked worktree as this user) must not dispatch. (Codex #4c-[9].)
{
  const dirL = mkdtempSync(join(tmpdir(), "reeve-e2e-label-"));
  const ctxL = { ...baseCtx(), db: open(join(dirL, "l.db")), logPath: join(dirL, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirL, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 platform: "darwin", profile: { ...profile, worker: { isolation: "scratch-home" } },
                 canary: async () => ({ ok: true, id: "good", why: null, evidence: {} }),
                 keychain: { measured: true, items: [], why: null } };
  delete ctxL.containment;
  let launchedL = 0;
  ctxL.spawnWorker = async () => { launchedL++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const rL = await tick(ctxL);
  // CHANGED 2026-08-22: the topology the label names is now implemented (a
  // scratch HOME workerEnv refuses to override, and a standalone clone), so the
  // label plus a passing canary dispatches. A profile that declares NOTHING
  // still refuses — that case is below.
  check(launchedL === 1, "a declared isolation with a passing canary dispatches", String(launchedL));
  ctxL.db.close();
  rmSync(dirL, { recursive: true, force: true });
}

// --- a rejected spawn refunds its attempt exactly ONCE -----------------------
//
// The spawn-time refusal and the pre-execution handler both refund, so doing it
// in both places took a cause from two spent attempts down to zero and handed
// back retries the cap had already spent.
{
  const dirR = mkdtempSync(join(tmpdir(), "reeve-e2e-refund-"));
  const fpR = causeKey("o/r", CAUSE);
  const ctxR = { ...baseCtx(), db: open(join(dirR, "r.db")), logPath: join(dirR, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirR, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 // A closed verdict whose binary identity no longer matches: the
                 // spawn is refused after the run row and the attempt exist.
                 containment: { credentialRead: "closed", why: "test", binaryId: "/some/other/claude@999" },
                 // The cap must allow a SECOND dispatch, or the pre-seeded attempt
                 // exhausts it and the tick escalates without ever reaching the
                 // spawn — the fixture would then pass whatever the refund does.
                 profile: { ...profile, rounds: { ...profile.rounds, maxFixAttemptsPerFinding: 3 } } };
  // One genuine attempt already spent on this cause.
  recordFixAttempt(ctxR.db, "o/r", 42, fpR);
  const before = countFixAttempts(ctxR.db, "o/r", 42, fpR);
  check(before === 1, "control: one attempt is on the ledger before the tick", String(before));
  ctxR.spawnWorker = async () => ({ outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" });
  await tick(ctxR);
  const after = countFixAttempts(ctxR.db, "o/r", 42, fpR);
  check(after === before, "a refused spawn refunds only its OWN attempt, leaving the earlier one spent", `${before} -> ${after}`);
  ctxR.db.close();
  rmSync(dirR, { recursive: true, force: true });
}

// --- a CLI binary swapped after the verdict is refused at the spawn -----------
{
  const dirB = mkdtempSync(join(tmpdir(), "reeve-e2e-binswap-"));
  const ctxB = { ...baseCtx(), db: open(join(dirB, "b.db")), logPath: join(dirB, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirB, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 // A closed verdict whose binary identity differs from the one the
                 // spawn resolves (/bin/sh) -> the per-spawn re-check refuses.
                 containment: { credentialRead: "closed", why: "test", binaryId: "/some/other/claude@999" } };
  let launchedB = 0;
  ctxB.spawnWorker = async () => { launchedB++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const rB = await tick(ctxB);
  check(launchedB === 0 && [...rB.escalations.keys()].includes("guardian:containment:changed"), "a CLI binary that changed since the verdict refuses the spawn", String(launchedB));
  check(/CLI binary changed/.test(readFileSync(join(dirB, "log.txt"), "utf8")), "and the log names the binary change", "");
  ctxB.db.close();
  rmSync(dirB, { recursive: true, force: true });
}

// --- a credential that appears after the verdict is caught at the spawn --------
{
  const dirK2 = mkdtempSync(join(tmpdir(), "reeve-e2e-credappear-"));
  const ctxK2 = { ...baseCtx(), db: open(join(dirK2, "k.db")), logPath: join(dirK2, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirK2, "wt-")), why: null, deps: { ok: true, cow: false } }),
                  // Verdict was closed, but the keychain now holds an item.
                  keychain: { measured: true, items: ["generic password gh:github.com (gh keyring)"], why: "appeared" } };
  let launchedK2 = 0;
  ctxK2.spawnWorker = async () => { launchedK2++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const rK2 = await tick(ctxK2);
  // CHANGED 2026-08-22: a credential appearing in the founder's keychain no
  // longer refuses a spawn, because the worker has no login keychain in its
  // search list. The binary-swap case above is what per-spawn revalidation
  // still guards, and the canary guards the reach.
  check(launchedK2 === 1, "a credential appearing in the host keychain no longer refuses the spawn", String(launchedK2));
  ctxK2.db.close();
  rmSync(dirK2, { recursive: true, force: true });
}

// --- the denied state roots are SPECIFIC, never an ancestor of the worktree --
//
// With `--log ~/reeve.log`, dirname(logPath) is the home directory: denying it
// would deny the very checkout the fixer was dispatched to read. The boundary
// must contain the worker, not break the work. (Codex #4e-[5].)
{
  const roots = stateRootsFor("/Users/x", "/Users/x/reeve.log", "/Users/x/code/repo/wt");
  check(!roots.includes("/Users/x"), "the log's PARENT directory is never denied wholesale", JSON.stringify(roots));
  check(roots.includes("/Users/x/reeve.log") && roots.includes("/Users/x/runs") && roots.includes("/Users/x/canary") && roots.includes("/Users/x/backups"),
    "the log file and reeve's own subtrees are denied by name", JSON.stringify(roots));
  const anc = stateRootsFor("/Users/x/code", "/Users/x/code/reeve.log", "/Users/x/code/runs/wt");
  check(!anc.includes("/Users/x/code/runs"), "a root that is an ancestor of the worktree is dropped rather than breaking the fixer", JSON.stringify(anc));
}

// --- an unmeasured platform stays open even with both probes green -----------
//
// The fail-closed matrix is per-OS: a sandbox measured on macOS says nothing
// about Linux or Windows, so a host reeve has not measured is refused whatever
// the canary and keychain say. This is the guard that makes "measured" mean the
// platform too, not just the two probes.
{
  const dirP = mkdtempSync(join(tmpdir(), "reeve-e2e-platform-"));
  const ctxP = { ...baseCtx(), db: open(join(dirP, "p.db")), logPath: join(dirP, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirP, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 platform: "win32",
                 canary: async () => ({ ok: true, id: "good", why: null, evidence: {} }),
                 keychain: { measured: true, items: [], why: null } };
  delete ctxP.containment;
  let launchedP = 0;
  ctxP.spawnWorker = async () => { launchedP++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  const rP = await tick(ctxP);
  check(launchedP === 0 && [...rP.escalations.keys()].includes("guardian:containment:open"), "an unmeasured platform refuses dispatch though both probes are green", String(launchedP));
  check(/unmeasured on win32/.test(readFileSync(join(dirP, "log.txt"), "utf8")), "and the log names the platform", "");
  ctxP.db.close();
  rmSync(dirP, { recursive: true, force: true });
}

// --- a heartbeat that cannot be written revokes too ---------------------------
//
// "Unknown is not alive": a store that refuses the write is treated exactly
// like a lease that is gone, with the write failure as the reason.
{
  const dir5 = mkdtempSync(join(tmpdir(), "reeve-e2e-hbfail-"));
  const ctx5 = { ...baseCtx(), db: open(join(dir5, "h.db")), logPath: join(dir5, "log.txt"), heartbeatMs: 100,
                 prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir5, "wt-")), why: null, deps: { ok: true, cow: false } }),
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
  const ctx6 = { ...baseCtx(), db: open(join(dir6, "v.db")), logPath: join(dir6, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir6, "wt-")), why: null, deps: { ok: true, cow: false } }),
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


// --- settings that fail validation never reach a worker ----------------------
//
// Measured: under -p the CLI drops an invalid settings file WHOLE and silently,
// deny rules included. A worker launched on one would run with no boundary and
// a contract row claiming otherwise. The validator runs before the file is
// written; a refusal is a preparation failure: no launch, refund, the reason
// in the log.
{
  const dirS = mkdtempSync(join(tmpdir(), "reeve-e2e-settings-"));
  const ctxS = { ...baseCtx(), db: open(join(dirS, "s.db")), logPath: join(dirS, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirS, "wt-")), why: null, deps: { ok: true, cow: false } }),
                 settingsValidator: () => ({ ok: false, errors: ["planted: sandbox.enabled must be true"] }) };
  let launchedS = 0;
  ctxS.spawnWorker = async () => { launchedS++; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  await tick(ctxS);
  check(launchedS === 0, "no worker launches when the generated settings fail validation", String(launchedS));
  const logS = readFileSync(join(dirS, "log.txt"), "utf8");
  check(/settings invalid: planted/.test(logS), "the log carries the validator's reason", logS.split("\n").filter(l => /#42/.test(l)).slice(-2).join(" | ").slice(0, 300));
  const prDirS = join(dirS, "runs", "o-r", "42");
  const writtenS = existsSync(prDirS) ? readdirSync(prDirS).filter(d => existsSync(join(prDirS, d, "sandbox-settings.json"))) : [];
  check(writtenS.length === 0, "and no settings file was written for the refused run", JSON.stringify(writtenS));
  check((ctxS.db.prepare("SELECT COALESCE(SUM(attempts),0) n FROM fix_attempt").get().n) === 0, "the attempt is refunded", "");
  ctxS.db.close();
  rmSync(dirS, { recursive: true, force: true });
}

// --- and the real validator accepts what the real policy generates -----------
//
// A seam that is only ever stubbed proves the seam, not the pair. One dispatch
// with the default validator, asserting that a worker WAS launched, is the
// positive control for every stubbed case above and below.
{
  const dirV = mkdtempSync(join(tmpdir(), "reeve-e2e-validator-"));
  const ctxV = { ...baseCtx(), db: open(join(dirV, "v.db")), logPath: join(dirV, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dirV, "wt-")), why: null, deps: { ok: true, cow: false } }) };
  let launchedV = 0, settingsSeen = null;
  ctxV.spawnWorker = async (args) => { launchedV++; const i = args.args.indexOf("--settings"); settingsSeen = i >= 0 ? JSON.parse(readFileSync(args.args[i + 1], "utf8")) : null; return { outcome: "ok", why: "d", ms: 1, cost: 0, sessionId: "s" }; };
  await tick(ctxV);
  check(launchedV === 1, "control: the default validator accepts the generated settings and a worker launches", String(launchedV));
  check(settingsSeen?.sandbox?.enabled === true && settingsSeen?.sandbox?.failIfUnavailable === true,
    "and the file the worker received carries the sandbox block", JSON.stringify(settingsSeen?.sandbox)?.slice(0, 200));
  check(Array.isArray(settingsSeen?.sandbox?.filesystem?.allowWrite) && settingsSeen.sandbox.filesystem.allowWrite.length === 1 && settingsSeen.sandbox.filesystem.allowWrite[0].endsWith("/tmp"),
    "whose only write grant is the run's own tmp", JSON.stringify(settingsSeen?.sandbox?.filesystem?.allowWrite));
  ctxV.db.close();
  rmSync(dirV, { recursive: true, force: true });
}

// --- a cooperative cancel closes the run as abandoned, never as failed ------
{
  const dir7 = mkdtempSync(join(tmpdir(), "reeve-e2e-cancel-"));
  const ctx7 = { ...baseCtx(), db: open(join(dir7, "c.db")), logPath: join(dir7, "log.txt"), heartbeatMs: 100,
                 prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir7, "wt-")), why: null, deps: { ok: true, cow: false } }), heartbeat: () => ({ alive: false, reason: "cancelled" }) };
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
  const ctx8 = { ...baseCtx(), db: open(join(dir8, "x.db")), logPath: join(dir8, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir8, "wt-")), why: null, deps: { ok: true, cow: false } }) };
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
  const ctx9 = { ...baseCtx(), db: open(join(dir9, "p.db")), logPath: join(dir9, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir9, "wt-")), why: null, deps: { ok: true, cow: false } }),
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
  const ctx10 = { ...baseCtx(), db: open(join(dir10, "u.db")), logPath: join(dir10, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir10, "wt-")), why: null, deps: { ok: true, cow: false } }) };
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
  const ctx11 = { ...baseCtx(), db: open(join(dir11, "b.db")), logPath: join(dir11, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir11, "wt-")), why: null, deps: { ok: true, cow: false } }) };
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
  const ctx12 = { ...baseCtx(), db: open(join(dir12, "c.db")), logPath: join(dir12, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir12, "wt-")), why: null, deps: { ok: true, cow: false } }), heartbeatMs: 3_600_000 };
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


// --- a recorder failure cannot turn an unbound launch into a spent failure --
{
  const dir13 = mkdtempSync(join(tmpdir(), "reeve-e2e-unbound-rec-"));
  const ctx13 = { ...baseCtx(), db: open(join(dir13, "r.db")), logPath: join(dir13, "log.txt"), prepareCheckout: () => ({ ok: true, path: mkdtempSync(join(dir13, "wt-")), why: null, deps: { ok: true, cow: false } }),
                  noteWorkerResult: () => { throw new Error("disk full"); } };
  ctx13.spawnWorker = async () => ({ outcome: "unbound", why: "run binding failed: x", ms: 1, cost: null, sessionId: null });
  const r13 = await tick(ctx13);
  check(ctx13.db.prepare("SELECT COALESCE(SUM(attempts),0) n FROM fix_attempt").get().n === 0, "the attempt is still refunded when the recorder fails", "");
  check([...(r13.escalations?.keys() ?? [])].some(k => /could not be prepared/.test(k)), "and the preparation backoff is still installed", [...(r13.escalations?.keys() ?? [])].join(" | "));
  const node13 = ctx13.db.prepare("SELECT status FROM node WHERE id='pr:42'").get();
  check(node13?.status !== "blocked", "and the PR is not blocked by a worker that never ran", JSON.stringify(node13));
  ctx13.db.close();
  rmSync(dir13, { recursive: true, force: true });
}

ctx.db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
