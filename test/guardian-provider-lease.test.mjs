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

// The daemon's constant, restated here only as an upper bound for an
// assertion -- the test asserts `<=`, so a change to the real value cannot make
// this pass wrongly.
const RATE_LIMIT_COOLDOWN_SECONDS_FOR_TEST = 600;

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
const run = async ({ hub, repoId = 7, claim, release, containmentThrows = false, hubGetter } = {}) => {
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
    hub: hubGetter ? () => hubGetter(guest) : () => ({ hub: guest, why: null }), repoId, lstart: "boot-1",
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
  // THE FUNCTION BODY, not the file. `/POLICY_APP/.test(src)` passes on the
  // import line and on any comment mentioning it, so it survives the classifier
  // being changed to stop using it -- verified: the stub that widened this to
  // every `[bot]` login left this assertion green. Same "a call, not a mention"
  // lesson as the version gate, unapplied one file over.
  const src = readFileSync(new URL("../src/pr.mjs", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("export function isBuilderPr"),
                       src.indexOf("export function prAnchor"));
  // COMMENTS STRIPPED, because the body EXPLAINS that it reads `POLICY_APP` --
  // and a bare test over the body passes on that explanation alone. Verified:
  // the stub that widened this to every `[bot]` login left the un-stripped
  // version green while the behavioural cases went red. Third time this shape
  // has appeared in this PR, each a level finer than the last: the file, then
  // the function, now the code within it.
  const code = fn.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/.*$/gm, " ");
  check(code.length > 0 && /isBuilderPr/.test(code),
    "control: the classifier's code was located with its comments removed", `${code.length} chars`);
  check(/POLICY_APP/.test(code),
    "the App's identity is READ from POLICY_APP in the classifier's code, not merely described",
    code.slice(0, 300));
  check(!/["`']merge-policy/.test(code),
    "and never restated as a literal there",
    (code.match(/.*merge-policy.*/g) ?? ["none"]).join(" | "));
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

  // A TICK THAT ACTUALLY ASKS keeps its request. The cancel phase is keyed on
  // what was asked, not on what was intended -- so this needs a canary that
  // really reaches the paid path and takes its lease.
  //
  // `isolation: "none"` would open containment on the cheap gates, no canary
  // would run, nothing would be asked, and the request would be correctly
  // cancelled: that is the case below, not this one.
  cancelled.length = 0;
  const b = base(true);
  delete b.containment;
  b.platform = "darwin";
  b.isolationReady = () => true;
  b.profile.worker = { isolation: "scratch-home" };
  b.canary = async ({ beforeSpawn }) => {
    const permit = await beforeSpawn();
    return permit.ok ? { ok: true, id: "c1", why: null, evidence: { outcome: "ok" } }
                     : { ok: false, id: "c1", why: permit.why, skipped: true, evidence: {} };
  };
  await tick(b); b.db.close();
  check(!cancelled.includes("canary:o/r"),
    "a tick that actually asks for the canary keeps its queued request",
    JSON.stringify(cancelled));

  // AND ITS OPPOSITE. With containment already open for a cheap reason no canary
  // will ever run, so holding its queue position blocks builder admission for
  // nothing. Cancelling is right, and the previous revision could not tell these
  // two cases apart because it predicted rather than observed.
  cancelled.length = 0;
  const d = base(true);
  delete d.containment;
  d.profile.worker = { isolation: "none" };
  await tick(d); d.db.close();
  check(cancelled.includes("canary:o/r"),
    "while a tick whose containment is already open cancels it",
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

// ── the CANARY's own rate limit reaches provider_state ────────────────────
// The canary is a paid model call. A failed canary is never a cache hit, so
// without recording its rate limit the next tick claims another slot and spends
// another request into the same exhausted window -- while builders stay eligible
// against the same untouched provider_state.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-canary-"));
  const cooldowns = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-canary-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5, model: "claude-x" },
      worker: { isolation: "scratch-home" },
    },
    // The canary RESULT is injected, carrying the shape `sandboxCanary` really
    // returns: the worker's outcome preserved in `evidence.outcome`.
    isolationReady: () => true,
    // PINNED, or this test measures the HOST. `cheapContainmentReasons` opens
    // containment on any platform but darwin, and `measuredContainment` returns
    // on a cheap reason before it ever consumes the canary -- so on the
    // ubuntu-latest runner this block passed locally and would have failed in
    // CI, which is down and could not have told me. The cooldown wiring is what
    // is under test; the platform gate is measured elsewhere.
    platform: "darwin",
    canary: { ok: false, id: "c1", why: "the canary was rate limited",
              evidence: { outcome: "rate_limited", why: "provider returned 429" } },
    hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
    providerClaim: () => ({ ok: true, id: 1, token: "t" }),
    providerRelease: () => ({ ok: true }),
    reapProvider: () => ({ ok: true, reaped: 0 }),
    queuedRequests: () => [],
    noteRateLimit: (db, a) => { cooldowns.push(a); return { ok: true, until: 1 }; },
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx); ctx.db.close();
  check(cooldowns.length > 0,
    "a rate-limited CANARY records the provider cooldown", JSON.stringify(cooldowns));
  check(cooldowns[0]?.cooldownSeconds > 0,
    "with a cooldown the next admission will see", JSON.stringify(cooldowns[0]));
  rmSync(dir, { recursive: true, force: true });
}

// ── every claim takes a FRESH handle, not the tick's opening snapshot ─────
// `restoreHub` replaces the hub file mid-tick, and a handle taken at the top
// then points at the unlinked pre-restore inode -- so a claim reserves capacity
// in a database no other process sees while the restored hub admits its own.
//
// The fixture has to be able to TELL: an earlier version returned the same
// object from the getter every time, so stale and fresh were indistinguishable
// and a stub that reverted the fix produced no failures at all. This getter
// hands out a different handle after the first call.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-fresh-"));
  const first = { tag: "pre-restore" };
  const second = { tag: "post-restore" };
  let asked = 0;
  const seen = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-fresh-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    // The first ask gets the pre-restore handle; every later one gets the
    // replacement, as a restore during the tick would produce.
    hub: () => ({ hub: (++asked === 1 ? first : second), why: null }),
    repoId: 7, lstart: "boot-1",
    providerClaim: (db, a) => { seen.push({ tag: db?.tag, runRef: a.runRef }); return { ok: true, id: seen.length, token: "t" }; },
    providerBind: (db, a) => { seen.push({ tag: db?.tag, runRef: `bind:${a.runRef}` }); return { ok: true, bound: 1 }; },
    providerRelease: () => ({ ok: true }),
    reapProvider: () => ({ ok: true, reaped: 0 }),
    queuedRequests: () => [],
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async a => { a.onSpawn?.({ pid: 4242, lstart: "worker-start" }); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; },
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx); ctx.db.close();

  check(asked > 1, "fixture: the tick asked for the hub more than once", String(asked));
  check(seen.length > 0, "fixture: at least one claim reached the scheduler", JSON.stringify(seen));
  const stale = seen.filter(x => x.tag === "pre-restore");
  check(stale.length === 0,
    "no claim or bind uses the handle taken at the top of the tick",
    JSON.stringify({ stale, seen }));
}

// ── and an UNREADABLE hub yields no handle, never the old one ─────────────
// `?? hub` was written as a safety fallback and was the defect: when the getter
// reports the hub gone, falling back to the handle taken at the top of the tick
// is exactly the unlinked-inode write the getter exists to prevent.
//
// The fixture above could not see it -- its getter always returned a hub, so the
// fallback never fired and a stub reverting the fix produced no failures. This
// one goes unreadable after the first ask, which is what a restore looks like.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-gone-"));
  const first = { tag: "pre-restore" };
  let asked = 0;
  const seen = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-gone-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    // Open once, then gone -- a restore replacing the file mid-tick.
    hub: () => (++asked === 1 ? { hub: first, why: null } : { hub: null, why: "the hub was replaced" }),
    repoId: 7, lstart: "boot-1",
    providerClaim: (db, a) => { seen.push({ tag: db?.tag ?? (db === null ? "null" : "other"), runRef: a.runRef }); return { ok: true, id: seen.length, token: "t" }; },
    providerBind: () => ({ ok: true, bound: 1 }),
    providerRelease: () => ({ ok: true }),
    reapProvider: () => ({ ok: true, reaped: 0 }),
    queuedRequests: () => [],
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async a => { a.onSpawn?.({ pid: 4242, lstart: "w" }); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; },
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  const r = await tick(ctx); ctx.db.close();
  check(asked > 1, "fixture: the tick asked for the hub again after the first open", String(asked));
  check(!seen.some(x => x.tag === "pre-restore"),
    "once the hub is gone, no claim is made with the handle from before it went",
    JSON.stringify(seen));
  check(/hub:unreadable/.test([...(r.escalations?.keys?.() ?? [])].join(" ")),
    "and the tick says the hub became unreadable", [...(r.escalations?.keys?.() ?? [])].join(" | "));
  rmSync(dir, { recursive: true, force: true });
}

// ── the provider lease is RENEWED while the worker works ──────────────────
// LEASE_SECONDS is 300 and watch.workerBudgetMinutes defaults to 20, so without
// a heartbeat every worker spends three quarters of its run holding an expired
// lease. Nothing over-admits today -- heldCount ignores expiry and the reaper
// spares a live holder -- but `expires_at` stops describing reality, and
// `expiredLeases` reads it.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-beat-"));
  const beats = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-beat-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
    // Fast enough that a short worker still gets one.
    heartbeatMs: 5,
    providerClaim: () => ({ ok: true, id: 1, token: "tok" }),
    providerBind: () => ({ ok: true, bound: 1 }),
    providerRelease: () => ({ ok: true }),
    providerHeartbeat: (db, a) => { beats.push(a); return { ok: true }; },
    reapProvider: () => ({ ok: true, reaped: 0 }),
    queuedRequests: () => [],
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    // Long enough for the 5ms beat to fire at least once.
    spawnWorker: async () => { await new Promise(r => setTimeout(r, 60)); return { outcome: "ok", why: "done", ms: 60, cost: 0, sessionId: "s" }; },
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx); ctx.db.close();
  check(beats.length > 0, "the provider lease is renewed while the worker runs", `${beats.length} beat(s)`);
  check(beats[0]?.owner === "guardian" && beats[0]?.repoId === 7 && beats[0]?.runRef != null,
    "renewed by IDENTITY, so it works before and after the spawn rebinds the row",
    JSON.stringify(beats[0]));
  check(beats[0]?.token === "tok",
    "carrying the claim's token, which the fence requires", JSON.stringify(beats[0]?.token));
  rmSync(dir, { recursive: true, force: true });
}

// ── the canary lease is claimed WHEN the canary spends, not before ────────
// Two rounds were spent predicting whether a canary would run: once claiming
// for a call the cheap gates refuse (queuing the canary and blocking builder
// admission every tick), once skipping the claim when the cache holds a FAILED
// entry -- a paid model call with no lease at all. The claim now happens inside
// the paid path, so the prediction does not exist.
{
  const mk = ({ canary, isolation = "scratch-home" }) => {
    const dir = mkdtempSync(join(tmpdir(), "reeve-prov-paid-"));
    const claims = [];
    return { dir, claims, ctx: {
      nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
      execute: true, shadow: true, running: 0,
      keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
      platform: "darwin", isolationReady: () => true,
      capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
      profile: {
        identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-paid-cl-")) },
        authority: { policy: "propose_and_merge" },
        rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
        ci: { provider: "github-actions", requiredChecks: [] },
        watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
        worker: { isolation },
      },
      canary,
      hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
      providerClaim: (db, a) => { claims.push(a.runRef); return { ok: true, id: claims.length, token: "t" }; },
      providerBind: () => ({ ok: true, bound: 1 }),
      providerRelease: () => ({ ok: true }),
      providerHeartbeat: () => ({ ok: true }),
      reapProvider: () => ({ ok: true, reaped: 0 }),
      queuedRequests: () => [],
      openPrs: () => [42],
      prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                         updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
      evaluate: () => EVAL,
      publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
      spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
      oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
      resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
      prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
    } };
  };

  // THE PAID PATH. A canary FUNCTION is what `measureContainment` calls when it
  // has no cheap reason and no cache hit, and it receives `beforeSpawn` -- so a
  // fixture that calls it is exercising exactly the seam the claim now lives in.
  let permitted = null;
  const paid = mk({ canary: async ({ beforeSpawn }) => {
    permitted = await beforeSpawn();
    return permitted.ok
      ? { ok: true, id: "c1", why: null, evidence: { outcome: "ok" } }
      : { ok: false, id: "c1", why: permitted.why, skipped: true, evidence: { outcome: "not-run" } };
  } });
  await tick(paid.ctx); paid.ctx.db.close();
  check(permitted?.ok === true, "the canary is ASKED before it spends anything", JSON.stringify(permitted));
  check(paid.claims.includes("canary:o/r"),
    "and the lease is claimed at that moment", JSON.stringify(paid.claims));

  // A CHEAP GATE means no canary and therefore no claim. Previously this
  // claimed anyway, and at capacity that queued the canary and blocked builder
  // admission every tick for a call that never happens.
  const cheap = mk({ canary: async ({ beforeSpawn }) => { await beforeSpawn(); return { ok: true, id: "c2", why: null, evidence: {} }; },
                     isolation: "none" });
  await tick(cheap.ctx); cheap.ctx.db.close();
  check(!cheap.claims.includes("canary:o/r"),
    "a cheap gate that opens containment means NO canary lease is claimed",
    JSON.stringify(cheap.claims));

  // AN INJECTED VERDICT spends nothing either, so it must not claim.
  const injected = mk({ canary: { ok: true, id: "c3", why: null, evidence: { outcome: "ok" } } });
  await tick(injected.ctx); injected.ctx.db.close();
  check(!injected.claims.includes("canary:o/r"),
    "nor does a verdict that was handed in rather than measured",
    JSON.stringify(injected.claims));
  check(injected.claims.length > 0,
    "control: the worker still claims its own, so this did not simply stop dispatch",
    JSON.stringify(injected.claims));

  for (const c of [paid, cheap, injected]) rmSync(c.dir, { recursive: true, force: true });
}

// ── a PR this tick could not READ keeps its queue position ────────────────
// Absence from `wanted` means "unknown", not "withdrawn": cancelling costs the
// guardian its place in the queue and lets a builder take the opening.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-unread-q-"));
  const cancelled = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-unread-q-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
    // One queued request for PR 42, and PR 42 cannot be evaluated this tick.
    queuedRequests: () => [{ run_ref: "o/r#42:FIX_CI" }, { run_ref: "o/r#99:FIX_CI" }],
    cancelQueued: (db, a) => { cancelled.push(a.runRef); return { ok: true, cancelled: 1 }; },
    providerClaim: () => ({ ok: true, id: 1, token: "t" }),
    providerBind: () => ({ ok: true, bound: 1 }),
    providerRelease: () => ({ ok: true }),
    reapProvider: () => ({ ok: true, reaped: 0 }),
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => ({ ok: false, why: "GitHub could not be reached" }),
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx); ctx.db.close();
  check(!cancelled.includes("o/r#42:FIX_CI"),
    "a queued request for a PR this tick could not read is KEPT", JSON.stringify(cancelled));
  check(cancelled.includes("o/r#99:FIX_CI"),
    "control: one for a PR this tick never saw at all is still cancelled", JSON.stringify(cancelled));
  rmSync(dir, { recursive: true, force: true });
}

// ── housekeeping runs even when this repository wants nothing ─────────────
// A guardian that died holding a lease leaves a row only its successor can
// clear, and a successor with nothing to dispatch is exactly the state a restart
// lands in. Gating the reaper on local demand reaped least in the case that
// needed it most, and the builder never calls it at all.
{
  const mk = (openPrs) => {
    const dir = mkdtempSync(join(tmpdir(), "reeve-prov-reap-"));
    const reaped = [];
    return { dir, reaped, ctx: {
      nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
      execute: true, shadow: true, running: 0,
      containment: { credentialRead: "closed", why: "test" },
      keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
      capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
      profile: {
        identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-reap-cl-")) },
        authority: { policy: "propose_and_merge" },
        rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
        ci: { provider: "github-actions", requiredChecks: [] },
        watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
      },
      hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
      reapProvider: () => { reaped.push(1); return { ok: true, reaped: 0 }; },
      queuedRequests: () => [],
      providerClaim: () => ({ ok: true, id: 1, token: "t" }),
      providerBind: () => ({ ok: true, bound: 1 }),
      providerRelease: () => ({ ok: true }),
      openPrs: () => openPrs,
      prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                         updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
      evaluate: () => EVAL,
      publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
      spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
      oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
      resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
      prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
    } };
  };
  const quiet = mk([]);                     // nothing open: no worker decisions at all
  await tick(quiet.ctx); quiet.ctx.db.close();
  check(quiet.reaped.length > 0,
    "a tick with no worker decisions still reaps abandoned leases", String(quiet.reaped.length));

  const busy = mk([42]);
  await tick(busy.ctx); busy.ctx.db.close();
  check(busy.reaped.length > 0, "control: and so does a tick that does have work", String(busy.reaped.length));
  rmSync(quiet.dir, { recursive: true, force: true });
  rmSync(busy.dir, { recursive: true, force: true });
}

// ── no hub is no scheduler, and that is decided BEFORE the repository id ──
// Asking for the id first turned the documented fail-open case into a total
// outage: an unreadable hub fails the id lookup too, so the canary was refused
// and skipDispatch set, over a lease that could not have been written anyway.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-nohub-"));
  const spawned = [];
  let permitted = null;
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    platform: "darwin", isolationReady: () => true,
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-nohub-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
      worker: { isolation: "scratch-home" },
    },
    // No hub AND no repository id: the state a guardian restarts into when the
    // hub cannot be read.
    hub: () => ({ hub: null, why: null }), repoId: null, lstart: "boot-1",
    canary: async ({ beforeSpawn }) => {
      permitted = await beforeSpawn();
      return permitted.ok ? { ok: true, id: "c1", why: null, evidence: { outcome: "ok" } }
                          : { ok: false, id: "c1", why: permitted.why, skipped: true, evidence: {} };
    },
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async a => { spawned.push(a); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; },
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx); ctx.db.close();
  check(permitted?.ok === true,
    "with no hub the canary is permitted rather than refused for a missing id", JSON.stringify(permitted));
  check(spawned.length === 1,
    "and the guardian still dispatches, unscheduled, as the fail-open decision says",
    JSON.stringify(spawned.length));
  rmSync(dir, { recursive: true, force: true });
}

// ── a deferred cooldown expires when it was MEANT to ──────────────────────
// A pending note carrying only a duration restarts the whole window at retry
// time, so an outage longer than the cooldown recovers and then imposes a fresh
// block for a window that had already passed.
{
  const pending = new Map();
  const notes = [];
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-cool-"));
  const mk = (reachable) => ({
    nwo: "o/r", db: open(join(dir, `s${notes.length}.db`)), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-cool-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5, model: "claude-x" },
    },
    hub: () => (reachable ? { hub: {}, why: null } : { hub: null, why: "unreadable" }),
    repoId: 7, lstart: "boot-1", cooldownRetry: pending,
    noteRateLimit: (db, a) => { notes.push(a); return { ok: true, until: 1 }; },
    providerClaim: () => ({ ok: true, id: 1, token: "t" }),
    providerBind: () => ({ ok: true, bound: 1 }),
    providerRelease: () => ({ ok: true }),
    reapProvider: () => ({ ok: true, reaped: 0 }),
    queuedRequests: () => [],
    openPrs: () => [42],
    prAnchor: () => ({ ok: true, headRef: "mp/bt-1-s0", baseRef: "main", state: "open", title: "t",
                       updatedAt: "x", head: "b".repeat(40), pin: { ok: true, sha: "b".repeat(40) }, authorLogin: "someone" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "rate_limited", why: "429", ms: 1, cost: 0, sessionId: "s" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  });

  // The hub is unreachable when the 429 lands, so the note is deferred.
  const a = mk(false); await tick(a); a.db.close();
  const held = [...pending.values()][0];
  check(pending.size === 1, "a cooldown that could not be written is deferred", JSON.stringify([...pending.keys()]));
  check(typeof held?.expiresAt === "number",
    "and it carries an ABSOLUTE expiry, not just a duration", JSON.stringify(held));
  check(held.expiresAt > Math.floor(Date.now() / 1000),
    "stamped from when the throttling was observed", JSON.stringify({ expiresAt: held.expiresAt }));

  // Retried once the hub is back: the window that is asked for is what REMAINS.
  const before = notes.length;
  const b = mk(true); await tick(b); b.db.close();
  check(notes.length > before, "the next reachable tick records it", `${before} -> ${notes.length}`);
  const sent = notes[notes.length - 1];
  check(sent.cooldownSeconds <= RATE_LIMIT_COOLDOWN_SECONDS_FOR_TEST,
    "and asks for no MORE than the original window, never a fresh one",
    JSON.stringify({ asked: sent.cooldownSeconds, original: RATE_LIMIT_COOLDOWN_SECONDS_FOR_TEST }));
  rmSync(dir, { recursive: true, force: true });
}

// ── an unreadable ANCHOR keeps its queue position too ─────────────────────
// There are two ways to fail a read, and the marker covered one. A PR whose
// anchor cannot be read takes an earlier exit than the evaluation failure, so
// the sweep saw it missing from `wanted` and cancelled its queued request.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-anchor-"));
  const cancelled = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-anchor-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
    queuedRequests: () => [{ run_ref: "o/r#42:FIX_CI" }, { run_ref: "o/r#99:FIX_CI" }],
    cancelQueued: (db, a) => { cancelled.push(a.runRef); return { ok: true, cancelled: 1 }; },
    providerClaim: () => ({ ok: true, id: 1, token: "t" }),
    providerBind: () => ({ ok: true, bound: 1 }),
    providerRelease: () => ({ ok: true }),
    reapProvider: () => ({ ok: true, reaped: 0 }),
    openPrs: () => [42],
    // The ANCHOR fails, not the evaluation.
    prAnchor: () => ({ ok: false, why: "GitHub could not be reached" }),
    evaluate: () => EVAL,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  await tick(ctx); ctx.db.close();
  check(!cancelled.includes("o/r#42:FIX_CI"),
    "a queued request for a PR whose ANCHOR could not be read is KEPT", JSON.stringify(cancelled));
  check(cancelled.includes("o/r#99:FIX_CI"),
    "control: one for a PR this tick never saw at all is still cancelled", JSON.stringify(cancelled));
  rmSync(dir, { recursive: true, force: true });
}

// ── housekeeping survives a GitHub outage ─────────────────────────────────
// The reaper needs nothing from GitHub -- it is SQLite and a liveness check --
// but it sat after the pull-request listing, which returns early when GitHub
// cannot be asked. So an expired lease from a dead guardian went on counting
// against capacity throughout an outage, with the database that could clear it
// healthy the whole time.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-outage-"));
  const reaped = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-outage-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: () => ({ hub: {}, why: null }), repoId: 7, lstart: "boot-1",
    reapProvider: () => { reaped.push(1); return { ok: true, reaped: 1 }; },
    queuedRequests: () => [],
    providerClaim: () => ({ ok: true, id: 1, token: "t" }),
    providerRelease: () => ({ ok: true }),
    // GitHub cannot be asked: `openPrs` answers null, which ends the tick early.
    openPrs: () => null,
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  const r = await tick(ctx); ctx.db.close();
  check(r?.unreadable === true, "fixture: the tick really did end early on the PR listing", JSON.stringify(r?.unreadable));
  check(reaped.length > 0,
    "and abandoned leases were still reaped, because that needs no GitHub at all",
    String(reaped.length));
  rmSync(dir, { recursive: true, force: true });
}

// ── a lookup that THROWS is an outage, and the tick must say so ───────────
// Newly load-bearing. While the CLI's lookup answered `null` for a hub it could
// not open, this catch was reachable only in theory; now that absent and
// unreachable are told apart, an unreadable hub arrives here as a throw. What
// must hold is both halves at once: the founder hears `guardian:hub:unreadable`,
// AND the tick carries on -- an unreadable scheduler fails OPEN, so a permissions
// fault on the builder's database must not stop the guardian working.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-idthrow-"));
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    containment: { credentialRead: "closed", why: "test" },
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-idthrow-cl-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: () => ({ hub: {}, why: null }),
    // No id known yet, and the lookup cannot answer: the hub is there and cannot
    // be reached. This is the shape `resolveRepoIdAt` now propagates.
    repoId: null,
    resolveRepoId: () => { const e = new Error("EACCES: permission denied, stat hub.db"); e.code = "EACCES"; throw e; },
    lstart: "boot-1",
    reapProvider: () => ({ ok: true, reaped: 0 }),
    queuedRequests: () => [],
    providerClaim: () => ({ ok: true, id: 1 }),
    providerRelease: () => ({ ok: true }),
    openPrs: () => [],
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  const r = await tick(ctx);
  const esc = [...(r.escalations?.keys?.() ?? [])];
  const logged = readFileSync(join(dir, "log.txt"), "utf8");
  ctx.db.close();
  check(esc.includes("guardian:hub:unreadable"),
    "a repository-id lookup that throws raises guardian:hub:unreadable", esc.join(" | "));
  check(/the repository id could not be resolved/.test(logged),
    "and the log says which read failed and why",
    logged.split("\n").filter(l => /repository id/.test(l)).join(" | "));
  check(r?.halted !== true,
    "and the tick still finishes: an unreadable scheduler fails OPEN", JSON.stringify(r?.halted));
  rmSync(dir, { recursive: true, force: true });
}

// ── the guard and the claim must ask the hub at the SAME moment ───────────
// The worker's lease was guarded on the hub read taken at the TOP of the tick
// while the claim beneath it took a current one. Those are different moments,
// and a tick is not instant: a hub that was unreadable at the first read and
// usable by the time dispatch came round meant the worker skipped `claimProvider`
// altogether and ran UNSCHEDULED against a scheduler that was available -- quota
// spent that the scheduler could not see, which is the whole failure it exists
// to prevent. Every other site in this file already re-read; this one did not.
{
  let reads = 0;
  const s = await run({
    hubGetter: (guest) => (++reads === 1
      ? { hub: null, why: "the hub could not be read at that instant" }
      : { hub: guest, why: null }),
  });
  check(reads > 1, "fixture: the tick really did read the hub more than once", String(reads));
  check(s.spawned.length === 1, "fixture: a worker is still dispatched", s.esc);
  const worker = s.claims.find(c => !/^canary:/.test(c.runRef));
  check(worker != null,
    "a hub unreadable only at the tick's FIRST read still gets the worker a lease",
    JSON.stringify(s.claims.map(c => c.runRef)));
}

// CONTROL: unreadable at EVERY read really does dispatch unscheduled, so the
// claim above is the RE-READ and not something the fixture does unconditionally.
{
  const s = await run({ hubGetter: () => ({ hub: null, why: "unreadable throughout" }) });
  check(s.spawned.length === 1, "control fixture: the worker is dispatched anyway — an unreadable scheduler FAILS OPEN", s.esc);
  check(!s.claims.some(c => !/^canary:/.test(c.runRef)),
    "control: with the hub unreadable at every read there is no lease to take",
    JSON.stringify(s.claims.map(c => c.runRef)));
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

  // THE REPOSITORY-ID READ moved out of this file's reach, deliberately. It was
  // asserted here by reading the CLI's source for `readOnly: true` and for the
  // shared timeout -- and a source-text assertion cannot fail when the logic
  // beneath it is disabled, which is exactly what happened to the benign/fault
  // split that lived in the same function. Both are now behavioural, over a hub
  // built in each state, in `test/repo-id-lookup.test.mjs`; that suite also
  // holds the assertion that fails if the decision is ever inlined back here.
  // No hub connection in the CLI restates the contention budget as a number.
  const literals = (cli.match(/new DatabaseSync\([^)]*timeout:\s*\d+/g) ?? []);
  check(literals.length === 0,
    "and no hub connection in the CLI restates the timeout as a literal",
    literals.join(" | "));

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
