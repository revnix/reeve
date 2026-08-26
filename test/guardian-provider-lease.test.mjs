// Model quota is global, and the guardian's tick spends it in TWO shapes: the
// containment canary once per tick, and a worker per decision. A dispatch site
// without a provider lease is capacity the scheduler cannot see, which is the
// entire failure the scheduler exists to prevent.
//
// The founder's rule is FAIL OPEN on an unreadable scheduler and FAIL CLOSED on
// an unscopeable one, and those are not the same case. A broken hub must not
// stop the guardian working. A missing repository id must stop it, because
// `provider_lease.repo_id` spans the live-request unique index and SQLite does
// not deduplicate keys containing a NULL -- so a lease scoped to nothing is
// invisible to the index and the guardian inserts a fresh live request on every
// tick while the limit never binds.
import { tick } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";
import { CLAUSE_IDS } from "../src/verdict.mjs";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const HEAD = "b".repeat(40);
const cl = (id, state, detail = "") => ({ id, state, detail });
const EVAL = {
  ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
  verdict: { state: "BLOCK", summary: "ci is red",
             clauses: CLAUSE_IDS.filter(id => id !== "hold")
               .map(id => (id === "ci" ? cl("ci", "BLOCK", "failing: unit") : cl(id, "PASS"))) },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  checks: { verdict: "RED", caused: ["unit"], failing: [{ name: "unit", id: "1" }] },
  reviewers: [], threads: {}, settled: { settled: true },
};

/**
 * One tick with the scheduler injected at the daemon's seams.
 *
 * `hub` is a marker object, not a database: the daemon only ever hands it to
 * `providerClaim` / `providerRelease`, both of which are injected here. A real
 * hub would test `provider.mjs`, which has its own suite; what is under test
 * here is whether the DAEMON asks, and what it does with each answer.
 */
const run = async ({ hub = {}, repoId = 7, claim, release, containmentThrows = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-"));
  const claims = [], releases = [], spawned = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: containmentThrows ? null : { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-clone-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub, repoId, lstart: "boot-1",
    providerClaim: (db, a) => { claims.push(a); return (claim ?? (() => ({ ok: true, id: claims.length })))(a); },
    providerRelease: (db, a) => { releases.push(a); return (release ?? (() => ({ ok: true })))(a); },
    openPrs: () => [42],
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async a => { spawned.push(a); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; },
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  const r = await tick(ctx);
  const out = { r, claims, releases, spawned, ctx,
                esc: [...(r.escalations?.keys?.() ?? [])].join(" | "),
                log: readFileSync(join(dir, "log.txt"), "utf8") };
  ctx.db.close();
  rmSync(dir, { recursive: true, force: true });
  return out;
};

// ── the happy path: a lease is taken and given back ───────────────────────
{
  const s = await run();
  check(s.spawned.length === 1, "control: the worker is dispatched", s.esc);
  check(s.claims.length >= 1, "a provider lease is claimed before dispatch", JSON.stringify(s.claims));
  const worker = s.claims.find(c => !/^canary:/.test(c.runRef));
  check(worker != null, "including one for the worker itself, not only the canary",
    JSON.stringify(s.claims.map(c => c.runRef)));
  check(worker?.owner === "guardian" && worker?.repoId === 7,
    "scoped to the guardian and the numeric repository id", JSON.stringify(worker));
  check(worker?.pid != null && worker?.lstart === "boot-1",
    "with a pid AND a start time, or a dead holder could never be reaped", JSON.stringify(worker));
  check(s.releases.some(r => r.runRef === worker.runRef),
    "and it is released again", JSON.stringify(s.releases));
  // The release must carry the IDENTITY, never the id alone: a restore clears
  // provider_lease and SQLite reuses the integer, so an id-only delete removes
  // whatever inherited that key -- an unrelated live lease.
  const rel = s.releases.find(r => r.runRef === worker.runRef);
  check(rel?.owner === "guardian" && rel?.repoId === 7 && rel?.runRef != null,
    "the release is fenced on the identity, not on the id alone", JSON.stringify(rel));
}

// ── a refusal is an ordinary outcome, not a failure ───────────────────────
{
  const s = await run({ claim: a => (/^canary:/.test(a.runRef) ? { ok: true, id: 1 } : { ok: false, reason: "at-limit" }) });
  check(s.spawned.length === 0, "a refused claim dispatches NO worker", JSON.stringify(s.spawned));
  check(/provider at-limit/.test(s.log), "and says which refusal it was", s.log.split("\n").filter(l => /provider/.test(l)).join(" | "));
  check(s.r?.halted !== true, "the TICK still finishes: a quota refusal is not a halt", JSON.stringify(s.r?.halted));
  check(!s.releases.some(r => r.runRef === "o/r#42:FIX_CI"),
    "and nothing is released that was never held", JSON.stringify(s.releases));
}

// ── FAIL OPEN when the scheduler cannot be read ───────────────────────────
{
  const s = await run({ claim: a => { if (!/^canary:/.test(a.runRef)) throw new Error("database disk image is malformed"); return { ok: true, id: 1 }; } });
  check(s.spawned.length === 1, "an unreadable scheduler does NOT stop the guardian working", s.esc);
  check(/unreadable/.test(s.esc), "but it says so, or unscheduled dispatch is indistinguishable from scheduled", s.esc);
}

// ── FAIL CLOSED when the lease cannot be scoped ───────────────────────────
{
  const s = await run({ repoId: null });
  check(s.spawned.length === 0, "an unscopeable lease dispatches NO worker", JSON.stringify(s.spawned));
  check(/repository numeric id is unknown/.test(s.esc),
    "and escalates, rather than failing silently", s.esc);
  check(s.claims.length === 0, "no claim is attempted with a null repository id", JSON.stringify(s.claims));
  // CONTROL: the same tick with an id DOES dispatch, or this block has merely
  // disabled dispatch rather than gating it on the id.
  const ok = await run({ repoId: 7 });
  check(ok.spawned.length === 1, "control: the same tick with a known id dispatches");
}

// ── A-9: a maintenance refusal is retried, never swallowed ────────────────
// `assertWritable` refuses every hub write while a restore holds the lock. A
// release dropped there leaves the lease held until it expires, counted against
// the limit the whole time -- the guardian throttling itself for five minutes
// over a restore that took one second.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-retry-"));
  const shared = {};                       // ctx.providerRetry lives across ticks
  let refuse = true;
  const releases = [];
  const mk = () => ({
    nwo: "o/r", db: open(join(dir, `s${releases.length}.db`)), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-retry-clone-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: {}, repoId: 7, lstart: "boot-1",
    providerRetry: shared.map ??= new Map(),
    providerClaim: () => ({ ok: true, id: 1 }),
    providerRelease: (db, a) => { releases.push({ ...a, refused: refuse }); return refuse ? { ok: false, reason: "maintenance" } : { ok: true }; },
    openPrs: () => [42],
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  });

  const a = mk(); await tick(a); a.db.close();
  const held = [...shared.map.keys()];
  check(held.length > 0, "a release refused for maintenance is REMEMBERED, not dropped", JSON.stringify(held));
  const kept = shared.map.get(held[0]);
  check(kept?.owner === "guardian" && kept?.repoId === 7 && kept?.runRef != null,
    "and what is kept is the IDENTITY — an id-keyed retry would delete whatever inherited that key after a restore",
    JSON.stringify(kept));

  refuse = false;
  const before = releases.length;
  const b = mk(); await tick(b); b.db.close();
  check(releases.length > before, "the next tick retries it", `${before} -> ${releases.length}`);
  check(shared.map.size === 0, "and a successful retry clears it, so it is not retried forever",
    JSON.stringify([...shared.map.keys()]));
  rmSync(dir, { recursive: true, force: true });
}

// ── A-11, scoped to the GUARDIAN ──────────────────────────────────────────
// The control the plan asked for forbids the privileged `openHub` in
// `bin/reeve`, and that assertion is unsatisfiable as written: both call sites
// there are the BUILDER's own commands, which legitimately hold the whole
// schema. What must be true is narrower and is the thing that matters -- the
// guardian's connection is the restricted one.
{
  const cli = readFileSync(new URL("../bin/reeve", import.meta.url), "utf8");
  check(/hub:\s*guardianHub\(\)/.test(cli),
    "the guardian's tick context is handed a hub",
    (cli.match(/hub:.*/) ?? []).slice(0, 2).join(" | "));
  const helper = cli.slice(cli.indexOf("const guardianHub"), cli.indexOf("const registryProjects"));
  check(/openHubAsGuest\(/.test(helper) && !/[^s]openHub\(/.test(helper),
    "and it is opened as a GUEST, never with the privileged opener", helper.slice(0, 300));
  const daemon = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(!/\bopenHub\b/.test(daemon),
    "and the guardian's own module cannot reach the privileged opener at all",
    (daemon.match(/.*\bopenHub\b.*/g) ?? []).join(" | "));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
