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
import { openHub } from "../src/build/hubdb.mjs";
import { openHubAsGuest } from "../src/build/hubguest.mjs";
import { resolveRepoId } from "../src/build/repoid.mjs";
import { COLUMNS_AT, SCHEDULER_MIN_HUB_VERSION } from "../src/build/hubdb.mjs";
import { isBuilderPr } from "../src/pr.mjs";
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
 * `hub` DEFAULTS TO A REAL GUEST CONNECTION, and that is not incidental. The
 * first version of this fixture passed a plain `{}` marker on the grounds that
 * the daemon only ever hands it to injected seams. That was true of the seams
 * and false of the daemon: it also handed the hub to the repository-id resolver,
 * which reads `task` -- a table the guest allowlist REFUSES. Against a marker
 * object nothing threw and every assertion passed; against the real connection
 * every production tick threw and fail-closed on every dispatch.
 *
 * A fixture that cannot exhibit the defect reports the code healthy. The default
 * is now the connection production actually uses.
 */
const run = async ({ hub, repoId = 7, claim, release, containmentThrows = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-"));
  const hubPath = join(dir, "hub.db");
  openHub(hubPath).close();
  const guest = hub === undefined ? openHubAsGuest(hubPath) : hub;
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
    hub: () => ({ hub: guest, why: null }), repoId, lstart: "boot-1",
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
  try { guest?.close?.(); } catch {}
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

// ── the repository id is NOT resolved through the guest connection ────────
// This is the defect the marker-object fixture could not see. `repoIdFromHub`
// reads `task`; the guest allowlist refuses it. A daemon that asks the guest for
// a repository id therefore throws on every production tick, leaves `repoId`
// null, and fail-closes every dispatch.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-guest-"));
  const hubPath = join(dir, "hub.db");
  openHub(hubPath).close();
  const guest = openHubAsGuest(hubPath);

  // The control that names the boundary: the guest genuinely cannot read `task`.
  // Without this the assertion below could pass because the table is empty.
  let why = null;
  try { guest.prepare("SELECT repo_id FROM task LIMIT 1"); } catch (err) { why = err.message; }
  check(why != null && /not authorized|prohibited|not permitted/i.test(why),
    "control: the guest connection REFUSES the table the resolver reads", String(why));

  // And the daemon must never put it in that position. `resolveRepoId` is a
  // privileged read by construction, so the tick has to be handed a number.
  const daemon = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(!/resolveRepoId\s*\(\s*(ctx\.)?hub/.test(daemon),
    "the daemon never hands its hub connection to the repository-id resolver",
    (daemon.match(/.*resolveRepoId.*/g) ?? []).join(" | "));

  // A tick against the real guest reaches dispatch rather than throwing.
  const s2 = await run({ repoId: 7 });
  check(s2.spawned.length === 1,
    "and a tick holding the real guest connection still dispatches", s2.esc);
  check(!/hub:unreadable/.test(s2.esc),
    "without reporting the hub unreadable", s2.esc);
  try { guest.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

// ── the hold reading is WIRED, not merely implemented ─────────────────────
// `openHold` was imported and never called: every unit test passed against a
// hold supplied by hand, the clause worked, and no production tick ever produced
// one -- so a pull request the builder had parked still reached FIX_CI. Proving
// a mechanism works is not proving it is reachable.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-hold-"));
  const hubPath = join(dir, "hub.db");
  const owner = openHub(hubPath);
  owner.exec(`INSERT INTO task(id,project,repo_id,nwo_snapshot,title,phase,generation,source_kind,source_key,
                repo_path,profile_path,profile_hash,default_branch,visibility,registry_version,created_at,updated_at)
              VALUES('bt:h','p',7,'o/r','t','IMPLEMENTING',1,'founder','k','/p','/f','h','main','private',1,
                     unixepoch(),unixepoch())`);
  owner.exec(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,detail,created_at)
              VALUES('bt:h',7,42,'${"b".repeat(40)}','ownership_lost','the task no longer owns this path',unixepoch())`);
  owner.close();
  const guest = openHubAsGuest(hubPath);

  // The verdict handed to `nextAction` is recomputed by the daemon from what
  // `evaluate` returns, so the hold has to arrive through the DAEMON's own read.
  // `evaluate` here deliberately reports no hold at all.
  let seen;
  const dir2 = mkdtempSync(join(tmpdir(), "reeve-prov-hold-st-"));
  const ctx = {
    nwo: "o/r", db: open(join(dir2, "s.db")), logPath: join(dir2, "log.txt"),
    execute: false, shadow: false, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir2, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-hold-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: () => ({ hub: guest, why: null }), repoId: 7, lstart: "boot-1",
    openPrs: () => [42],
    // THE ANCHOR IS THE CLASSIFIER'S INPUT. The tick decides whether a pull
    // request is the builder's from the head ref and the author, and reads
    // `pr_hold` only for those -- so a fixture with no anchor is correctly
    // classified as a stranger's PR and never reaches the hub at all.
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open",
                       title: "t", updatedAt: "2026-08-26T00:00:00Z", head: "b".repeat(40),
                       pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: (a) => { seen = a; return EVAL; },
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir2, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx);
  ctx.db.close();
  check(seen?.hold != null, "evaluatePr is handed a hold reading by the tick", JSON.stringify(seen?.hold));
  check(seen?.hold?.readable === true && seen?.hold?.held === true,
    "and it is the row the builder actually wrote, read through the GUEST connection",
    JSON.stringify(seen?.hold));
  check(seen?.hold?.reason === "ownership_lost",
    "carrying the reason the guardian renders", JSON.stringify(seen?.hold));
  try { guest.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
}

// ── an UNREADABLE hub reaches the verdict as UNKNOWN, not as silence ──────
// Passing a bare null when the hub could not be opened made computeVerdict omit
// the clause, which reads as "not asked" -- so the same tick could publish a
// passing verdict while the builder's holds were unreadable. Absent is null;
// unreadable is a reading that says so.
{
  let seen;
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-unread-"));
  const base = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: false, shadow: false, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-unread-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    repoId: 7, lstart: "boot-1",
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open",
                       title: "t", updatedAt: "x", head: "b".repeat(40),
                       pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: (a) => { seen = a; return EVAL; },
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  const r1 = await tick({ ...base, hub: () => ({ hub: null, why: "the hub could not be opened as a guest: disk image is malformed" }) });
  base.db.close();
  check(seen?.hold?.readable === false,
    "an unreadable hub becomes a hold reading that says so", JSON.stringify(seen?.hold));
  check(/malformed/.test(seen?.hold?.why ?? ""),
    "carrying the reason, so the verdict can say why it cannot answer", JSON.stringify(seen?.hold));
  check(/hub:unreadable/.test([...(r1.escalations?.keys?.() ?? [])].join(" ")),
    "and it escalates as well as blocking", [...(r1.escalations?.keys?.() ?? [])].join(" | "));

  // CONTROL: a hub that is genuinely ABSENT stays null -- no clause at all. A
  // guardian on a machine with no builder must not have every verdict dragged to
  // UNKNOWN over a question nobody put to it.
  seen = undefined;
  const b2 = { ...base, db: open(join(dir, "s2.db")), hub: () => ({ hub: null, why: null }) };
  await tick(b2); b2.db.close();
  check(seen?.hold === null, "control: an ABSENT hub is still no clause at all", JSON.stringify(seen?.hold));
  rmSync(dir, { recursive: true, force: true });
}

// ── the hold is read only for the builder's own pull requests ─────────────
// `pr_hold` records nothing else, so consulting it for a stranger's PR can only
// return PASS -- or, when the table is unreadable, an UNKNOWN that blocks every
// pull request in the repository over rows none of them have.
{
  for (const [label, headRef, authorLogin, wantAsked] of [
    ["a builder branch",   "mp/bt-1-s0",       "someone",           true],
    ["the builder App",    "feature/ordinary", "merge-policy[bot]", true],
    ["a lookalike branch", "mpx/not-ours",     "someone",           false],
    ["a stranger's PR",    "feature/ordinary", "someone",           false],
    ["dependabot",         "dependabot/x",     "dependabot[bot]",   false],
  ]) {
    let seen;
    const dir = mkdtempSync(join(tmpdir(), "reeve-prov-cls-"));
    const ctx = {
      nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
      execute: false, shadow: false, running: 0,
      containment: { credentialRead: "closed", why: "test" },
      keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
      capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
      profile: {
        identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-cls-cl-")) },
        authority: { policy: "propose_and_merge" },
        rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
        ci: { provider: "github-actions", requiredChecks: [] },
        watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
      },
      // An UNREADABLE hub, deliberately: it is the case where asking and not
      // asking produce visibly different verdicts.
      hub: () => ({ hub: null, why: "unreadable for this fixture" }),
      repoId: 7, lstart: "boot-1",
      openPrs: () => [42],
      prAnchor: () => ({ ok: true, headRef, baseRef: "main", state: "open", title: "t",
                         updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin }),
      evaluate: (a) => { seen = a; return EVAL; },
      publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
      oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
      resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
      prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
    };
    await tick(ctx); ctx.db.close();
    const asked = seen?.hold != null;
    check(asked === wantAsked,
      `${label}: the hold is ${wantAsked ? "read" : "NOT read"}`, JSON.stringify(seen?.hold));
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── the scheduler's schema floor is the column it actually needs ──────────
// "The hub opened" is not "the scheduler can be used". Every claim names
// `provider_lease.token`, which migration 3 adds -- so against an older hub each
// claim throws and the guardian's fail-open path runs model work outside the
// shared limit, beside an older builder still using its own.
{
  const need = COLUMNS_AT[SCHEDULER_MIN_HUB_VERSION] ?? {};
  check(need.provider_lease?.token != null,
    "the scheduler's floor is the version that introduces provider_lease.token",
    JSON.stringify({ floor: SCHEDULER_MIN_HUB_VERSION, declares: Object.keys(need) }));
  // Both directions: no EARLIER version may already declare it, or the floor is
  // higher than it needs to be and refuses hubs that would have worked.
  const earlier = Object.entries(COLUMNS_AT)
    .filter(([v]) => Number(v) < SCHEDULER_MIN_HUB_VERSION)
    .filter(([, cols]) => cols.provider_lease?.token != null)
    .map(([v]) => v);
  check(earlier.length === 0,
    "and no earlier version declares it, so the floor is not higher than it needs to be",
    earlier.join(","));

  // The BEHAVIOUR of the floor -- that an older hub is refused, with a reason,
  // and that a current one still opens -- lives in
  // `test/guardian-hub-access.test.mjs`, where it can actually be exercised. A
  // structural echo of it here would be a second statement of one fact, and the
  // weaker of the two.
}

// ── the classifier matches the APP, not every bot ─────────────────────────
// `user.type` is `Bot` for dependency bots, review bots and every other
// integration. Testing it pulled all of them into a table that has no row for
// any of them -- so during a hub fault they would take an UNKNOWN hold clause
// and an action-required policy result.
{
  for (const [label, meta, want] of [
    ["a builder branch",   { headRef: "mp/bt-1-s0" }, true],
    ["the builder App",    { headRef: "feature/ordinary", authorLogin: "merge-policy[bot]" }, true],
    ["both at once",       { headRef: "mp/bt-2-s0", authorLogin: "merge-policy[bot]" }, true],
    ["dependabot",         { headRef: "dependabot/npm_and_yarn/x", authorLogin: "dependabot[bot]" }, false],
    ["a review bot",       { headRef: "feature/ordinary", authorLogin: "coderabbitai[bot]" }, false],
    ["a human",            { headRef: "feature/ordinary", authorLogin: "mobeenabdullah" }, false],
    // The control that keeps `mp/` a SEGMENT prefix rather than a string one.
    ["a lookalike branch", { headRef: "mpx/not-ours", authorLogin: "someone" }, false],
  ]) check(isBuilderPr(meta) === want, `${label}: isBuilderPr is ${want}`, JSON.stringify(meta));

  // The App name is READ from where it already lives rather than restated here.
  const src = readFileSync(new URL("../src/pr.mjs", import.meta.url), "utf8");
  check(/POLICY_APP/.test(src) && !/"merge-policy\[bot\]"/.test(src),
    "and the App's name is read from POLICY_APP, not restated in the classifier",
    (src.match(/.*merge-policy.*/g) ?? []).join(" | "));
}

// ── a release survives a hub that is momentarily unreachable ──────────────
// The exception path and the maintenance refusal were both retried, and the
// third route out -- a hub unreadable between the claim and the cleanup -- threw
// the identity away. A pre-bind lease sits on the guardian's always-alive pid,
// so even past expiry the liveness-aware reaper keeps it and the slot is gone
// for good.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-drop-"));
  const hubPath = join(dir, "hub.db");
  openHub(hubPath).close();
  const guest = openHubAsGuest(hubPath);
  const retry = new Map();
  let reachable = true;
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-drop-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    // Reachable while the claim happens, unreadable by the time cleanup runs --
    // which is exactly the window this guards.
    hub: () => (reachable ? { hub: guest, why: null } : { hub: null, why: "the hub could not be read just now" }),
    repoId: 7, lstart: "boot-1",
    providerRetry: retry,
    providerClaim: () => ({ ok: true, id: 1, token: "t" }),
    providerBind: () => ({ ok: true, bound: 1 }),
    providerRelease: () => ({ ok: true }),
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => { reachable = false; return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; },
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  const r = await tick(ctx); ctx.db.close();
  check(retry.size > 0,
    "a release whose hub is unreachable is RETAINED for the next tick, not dropped",
    JSON.stringify([...retry.keys()]));
  const kept = [...retry.values()][0];
  check(kept?.owner === "guardian" && kept?.repoId === 7 && kept?.runRef != null,
    "and what is kept is the identity", JSON.stringify(kept));
  check(/hub:unreadable/.test([...(r.escalations?.keys?.() ?? [])].join(" ")),
    "and the unreachable hub escalates", [...(r.escalations?.keys?.() ?? [])].join(" | "));
  try { guest.close(); } catch {}
  rmSync(dir, { recursive: true, force: true });
}

// ── the canary's queued request is cancelled when no canary will run ──────
// Treating `canary:<nwo>` as intended unconditionally left a queued canary
// request alive through every later tick with no worker decisions: never
// claimed, never cancelled, owned by the live guardian so the reaper keeps it,
// and blocking every builder admission behind it.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-sweep-"));
  const cancelled = [];
  const base = (decisionsWanted) => ({
    nwo: "o/r", db: open(join(dir, `s${cancelled.length}.db`)), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-sweep-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
    // A queued canary request is already sitting in the scheduler.
    queuedRequests: () => [{ run_ref: "canary:o/r" }],
    cancelQueued: (db, a) => { cancelled.push(a.runRef); return { ok: true, cancelled: 1 }; },
    reapProvider: () => ({ ok: true, reaped: 0 }),
    providerClaim: () => ({ ok: true, id: 1, token: "t" }),
    providerBind: () => ({ ok: true, bound: 1 }),
    providerRelease: () => ({ ok: true }),
    openPrs: () => (decisionsWanted ? [42] : []),
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  });

  // No open pull requests, so nothing is wanted and no canary will be attempted.
  const a = base(false); await tick(a); a.db.close();
  check(cancelled.includes("canary:o/r"),
    "a queued canary request is cancelled on a tick that will not run one",
    JSON.stringify(cancelled));

  // CONTROL: a tick that WILL attempt the canary must NOT cancel its request, or
  // the sweep withdraws the very thing the next few lines are about to ask for.
  //
  // `containment` is deliberately NOT injected here -- injecting it is what makes
  // `willAttemptCanary` false, which is correct behaviour and was why the first
  // version of this control failed. With `worker.isolation` at its default the
  // cheap gates in `measuredContainment` answer without ever running a canary
  // process, so this stays deterministic and host-independent.
  cancelled.length = 0;
  const b = base(true);
  delete b.containment;
  b.profile.worker = { isolation: "none" };
  await tick(b); b.db.close();
  check(!cancelled.includes("canary:o/r"),
    "control: a tick that WILL run the canary leaves its request alone",
    JSON.stringify(cancelled));
  // And the discrimination itself: a run ref this tick did not decide on IS
  // cancelled, in the same sweep that spared the canary.
  cancelled.length = 0;
  const c = base(true);
  delete c.containment;
  c.profile.worker = { isolation: "none" };
  c.queuedRequests = () => [{ run_ref: "o/r#99:FIX_CI" }];
  await tick(c); c.db.close();
  check(cancelled.includes("o/r#99:FIX_CI"),
    "a queued request for a PR this tick never decided on is cancelled",
    JSON.stringify(cancelled));
  rmSync(dir, { recursive: true, force: true });
}

// ── A-9: a maintenance refusal is retried, never swallowed ────────────────
// `assertWritable` refuses every hub write while a restore holds the lock. A
// release dropped there leaves the lease held until it expires, counted against
// the limit the whole time -- the guardian throttling itself for five minutes
// over a restore that took one second.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-retry-"));
  const retryHubPath = join(dir, "hub.db");
  openHub(retryHubPath).close();
  const retryGuest = openHubAsGuest(retryHubPath);
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
    hub: () => ({ hub: retryGuest, why: null }), repoId: 7, lstart: "boot-1",
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
  try { retryGuest.close(); } catch {}
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
  check(/hub:\s*guardianHubAccess\(\)/.test(cli),
    "the guardian's tick context is handed a hub getter",
    (cli.match(/hub:.*/) ?? []).slice(0, 2).join(" | "));

  // The connection itself is built by `src/build/hubaccess.mjs`, which is tested
  // behaviourally. What must hold HERE is only the wiring: that the guardian's
  // context is handed that getter and not something assembled inline.
  check(/hubAccess\(hubPathFor\(HOME\)\)/.test(cli),
    "and it comes from the extracted, tested hub accessor",
    (cli.match(/const guardianHubAccess.*/) ?? [""])[0]);

  // THE REPOSITORY-ID READ IS READ-ONLY AND DOES NOT MIGRATE. `openHub` applies
  // every pending migration before answering, and this path holds no builder
  // singleton lease -- so a newer guardian restarting beside an older running
  // builder would upgrade the schema underneath it. A lookup must never be a
  // schema change.
  const resolver = cli.slice(cli.indexOf("const repoIdOnce"), cli.indexOf("const registryProjects"));
  check(/readOnly:\s*true/.test(resolver) && !/openHub\(/.test(resolver),
    "the repository-id read uses a read-only connection, never the migrating opener",
    resolver.slice(0, 400));
  check(/finally\s*\{[^}]*close/.test(resolver),
    "and closes it on every path out", resolver.slice(0, 400));

  // That the readiness gate reads the version ITSELF rather than through
  // `completedVersion` -- which catches every failure and answers 0 -- is now a
  // behavioural assertion over a corrupt file in the hub-access suite.

  const daemon = readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8");
  check(!/\bopenHub\b/.test(daemon),
    "and the guardian's own module cannot reach the privileged opener at all",
    (daemon.match(/.*\bopenHub\b.*/g) ?? []).join(" | "));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
