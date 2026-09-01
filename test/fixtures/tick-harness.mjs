// The tick fixture, shared.
//
// EXTRACTED from test/guardian-provider-lease.test.mjs rather than rewritten,
// because that fixture is the one with the history: its default hub is a REAL
// guest connection over a REAL hub file, after an earlier version passed a `{}`
// marker and a fixture that cannot exhibit the defect reported the code
// healthy. A second, freshly written vehicle would start without that.
//
// Two additions, both inert for the lease suite:
//   `keepDir`   returns the temp dir and hub path instead of removing them, so
//               a caller can dump the database after the tick.
//   `seams`     an array that records every scheduler seam call in order, as
//               {op, args}. Recorded by WRAPPING the seams here, never in src/.

// FROM THE SAME MODULE THE DAEMON RESOLVES IT FROM. `containment.mjs` exports a
// `measureContainment`, and the daemon's fallback here is `measuredContainment`
// -- a different function, defined in daemon.mjs, with a different signature.
// Importing the similarly-named one type-checked, satisfied a `typeof fn ===
// "function"` guard, and crashed the tick. The control below now derives these
// pairs from the daemon's own source.
import { tick, measuredContainment } from "../../src/daemon.mjs";
import { open } from "../../src/db/ops.mjs";
import { openHub } from "../../src/build/hubdb.mjs";
import { openHubAsGuest } from "../../src/build/hubguest.mjs";
// The scheduler fallbacks the daemon reaches for when ctx does not carry them.
// They are imported HERE so the harness can put a recording wrapper in ctx --
// otherwise `(ctx.reapProvider ?? reapProviderLeases)` runs the real one and the
// call never appears in the signature.
// A NAMESPACE, not named bindings. `run()` takes options named after the seams
// it overrides, so a named import shares its identifier with a parameter and the
// parameter WINS inside the function -- silently, because the result is
// `undefined` rather than an error. MEASURED: `FALLBACKS.cancelQueued` resolved
// to the (absent) parameter, so that seam was never installed and every tick ran
// the production function unrecorded, while the block below looked like it
// covered five seams and covered four. A namespace cannot collide.
import * as provider from "../../src/provider.mjs";
import { queuedGuardianRequests } from "../../src/build/providerdb.mjs";

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUSE_IDS } from "../../src/verdict.mjs";

// The fixture's evaluation payload. It lives HERE because run() closes over it;
// leaving it in the suite would make the harness depend on its importer.
export const HEAD = "b".repeat(40);
// The incarnation token the default claim hands back. Exported so a caller can
// assert the release carries the token the claim issued rather than merely
// carrying one.
export const CLAIM_TOKEN = "tok-fixture-1";

// The scheduler seams the daemon reaches for when `ctx` does not carry them.
// AT MODULE SCOPE so callers can assert coverage against the list the harness
// really installs: a hand-written copy of these names in a test would drift the
// moment one is added, and the artifact would stay green over a seam nothing
// watches.
const FALLBACKS = {
  reapProvider: provider.reapProviderLeases,
  cancelQueued: provider.cancelQueued,
  providerBind: provider.bindProviderLease,
  providerHeartbeat: provider.heartbeatProvider,
  noteRateLimit: provider.noteRateLimit,
  queuedRequests: queuedGuardianRequests,
  // MEASURED to be missing: the canary scenario reached the real
  // `measureContainment` through the daemon's own fallback, so the call decided
  // whether the tick dispatched at all and appeared in no artifact.
  measureContainment: measuredContainment,
};
export const SCHEDULER_SEAMS = Object.freeze(Object.keys(FALLBACKS));
// The functions too, so a caller can check each is the one the daemon would
// have reached for -- not merely that it is a function.
export const SCHEDULER_FALLBACKS = Object.freeze({ ...FALLBACKS });
const cl = (id, state, detail = "") => ({ id, state, detail });
export const EVAL = {
  ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
  verdict: { state: "BLOCK", summary: "ci is red",
             clauses: CLAUSE_IDS.filter(id => id !== "hold")
               .map(id => (id === "ci" ? cl("ci", "BLOCK", "failing: unit") : cl(id, "PASS"))) },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  checks: { verdict: "RED", caused: ["unit"], failing: [{ name: "unit", id: "1" }] },
  reviewers: [], threads: {}, settled: { settled: true },
};

export const run = async ({ hub, repoId = 7, claim, release, containmentThrows = false, hubGetter,
                    heartbeatMs, providerHeartbeat, spawnWorker, capacity,
                    queuedRequests, cancelQueued, measureContainment, noteRateLimit,
                    carriedReleases, carriedCooldowns, providerBind,
                    resolveRepoIdFn, project, keepDir = false, seams = null,
                    haltMarker, openPrs, containment, ticks = 1, dbPath, evaluate } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "reeve-prov-"));
  const hubPath = join(dir, "hub.db");
  openHub(hubPath).close();
  const guest = hub === undefined ? openHubAsGuest(hubPath) : hub;
  const claims = [], releases = [], spawned = [];
  const ctx = {
    // A STORE THIS RUN DID NOT CREATE, when the caller names one. `bin/reeve`
    // builds a fresh context per process, so "the daemon restarted" means a new
    // ctx over an EXISTING store -- and a fixture that always makes its own store
    // cannot express it at all. Anything a tick is supposed to carry across a
    // restart has to be read back from the store, and this is the only way to
    // watch it happen.
    nwo: "o/r", db: open(dbPath ?? join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0,
    // OVERRIDABLE, and the default is a verdict with NO canary in it. The
    // daemon's containment verdict carries the canary's own result beside the
    // credential answer, and the two are different facts: a scenario about what
    // the tick does when the SANDBOX stopped containing a worker cannot be
    // expressed by a `credentialRead` alone. Written as a fixed literal, this
    // made every canary branch in the tick unreachable through this harness.
    containment: containmentThrows ? null
               : (Array.isArray(containment) ? containment[0]
                  : (containment ?? { credentialRead: "closed", why: "test" })),
    keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    capacity: capacity ?? (() => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 })),
    profile: {
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-prov-clone-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    hub: hubGetter ? () => hubGetter(guest) : () => ({ hub: guest, why: null }), repoId, lstart: "boot-1",
    // OBLIGATIONS A PREVIOUS TICK LEFT BEHIND. `tick()` reads these as
    // `(ctx.providerRetry ??= new Map())`, so a fixture that never sets them
    // starts every tick with nothing owed -- and the whole retry half of the
    // scheduler, including the gate that decides whether a carried release is
    // even attempted, is then unreachable. A signature taken only from ticks
    // that owe nothing cannot see a change to what happens when one does.
    ...(carriedReleases ? { providerRetry: new Map(carriedReleases) } : {}),
    ...(carriedCooldowns ? { cooldownRetry: new Map(carriedCooldowns) } : {}),
    // THE HALT MARKER. `tick()` consults `ctx.haltMarker` at four points and
    // stops at whichever it reaches first, and the halt path withdraws this
    // guardian's queued requests on the way out. It was a declared parameter
    // that was never placed in ctx, so no caller could reach any of it: the
    // whole halt path was unreachable through this harness.
    ...(haltMarker ? { haltMarker } : {}),
    // Injected so the repository-id read can be OBSERVED. The daemon consults
    // `ctx.resolveRepoId` only when `repoId` is null, so a test that wants to
    // watch the call must pass both.
    ...(resolveRepoIdFn ? { resolveRepoId: resolveRepoIdFn } : {}),
    // Opt-in, because `repoIdFromHub` returns before touching the connection
    // unless `project.name` is set -- so a fixture without one cannot exhibit a
    // connection-passing regression at all, and any assertion about it is
    // vacuous. Production always has a project; the test that asserts over the
    // connection must too.
    ...(project ? { project } : {}),
    // PRODUCTION'S SHAPE, not a truncation of it. `claimProvider` answers
    // { ok, id, token, owner, repoId, runRef }, and the TOKEN is the fence that
    // stops a release issued before a restore from deleting a lease that has
    // since been reused by someone else. A default answering only { ok, id }
    // made the daemon carry `token: got.token ?? null` into every release, so a
    // recorded release read `"token":null` and dropping the token from the
    // release path changed nothing observable. It is a fixed string rather than
    // a generated one because the fixture is built fresh per run: the value is
    // behaviour to be compared, not noise to be normalised.
    providerClaim: (db, a) => {
      claims.push(a);
      return (claim ?? ((asked) => ({ ok: true, id: claims.length, token: CLAIM_TOKEN,
                                      owner: asked.owner, repoId: asked.repoId, runRef: asked.runRef })))(a);
    },
    providerRelease: (db, a) => { releases.push(a); return (release ?? (() => ({ ok: true })))(a); },
    // OVERRIDABLE. This was written as a fixed literal beside a `openPrs`
    // PARAMETER that nothing then read, so a caller could pass one and the tick
    // would still list the same single pull request. An option that reaches
    // nothing is worse than no option: it reads as coverage.
    openPrs: openPrs ?? (() => [42]),
    // `observe` reaches the network, and unstubbed it dominated this file's runtime:
    // four `gh api` round trips per tick against `o/r`, which does not exist, so
    // every one waited for a 404. The value below is what the real call ALREADY
    // returns here -- an incomplete read with an unreadable thread count -- not a
    // success. Returning `ok: true` would be a different test: the fold treats a
    // complete read and a partial one differently.
    observe: () => ({ ok: false, observations: [], incomplete: true,
                      threads: { readable: false, total: null, unresolved: 0, seen: 0 } }),
    // OVERRIDABLE. A tick is COMPLETE only when every listed pull request was
    // evaluated, and `complete` is what `announceable` consults before it retires
    // a standing cause that names no pull request. With a fixed evaluator no
    // fixture could produce an INCOMPLETE tick at all, so the whole branch that
    // decides whether absence may be read as repair was unreachable.
    evaluate: evaluate ?? (() => EVAL),
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: spawnWorker ?? (async a => { spawned.push(a); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; }),
    ...(heartbeatMs != null ? { heartbeatMs } : {}),
    ...(providerHeartbeat ? { providerHeartbeat } : {}),
    ...(queuedRequests ? { queuedRequests } : {}),
    ...(cancelQueued ? { cancelQueued } : {}),
    ...(measureContainment ? { measureContainment } : {}),
    // The cooldown recorder. Injectable because it REFUSES rather than throws
    // while a restore holds the hub, and a refusal is the branch that carries the
    // note to the next tick -- a scenario cannot reach that branch without
    // saying so here.
    ...(noteRateLimit ? { noteRateLimit } : {}),
    // The rebind onto the worker. Injectable because the real one answers
    // `bound: 0` against this fixture -- `providerClaim` is stubbed and writes no
    // row, so there is nothing to rebind -- and the daemon treats a zero-row
    // rebind as a preparation failure and ends the run. A scenario that wants to
    // watch what happens AFTER the worker starts has to get past it.
    ...(providerBind ? { providerBind } : {}),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: () => ({ ok: true, job: "unit", step: "t", cause: [{ where: "x:1", message: "boom" }] }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  // WRAP THE SEAMS HERE, not in src/. Every scheduler call is recorded in
  // order with its arguments; the order is the signal a refactor must preserve.
  if (seams) {
    // DERIVED, never hand-listed. A written-out list of seam names is a rule at
    // N sites: a seam added later is simply not recorded, and the artifact stays
    // green while the thing it exists to watch goes unwatched. MEASURED -- the
    // first version of this listed nine invented names, of which exactly one
    // (`hub`) existed, so the log recorded six getter calls and nothing else and
    // still looked like a populated artifact.
    // FIRST, give ctx the seams the daemon would otherwise reach past it for.
    // `tick()` resolves each as `(ctx.NAME ?? fallback)`, so a seam ABSENT from
    // ctx runs the production fallback and is never recorded -- the artifact then
    // shows no reaper and no queue read at all, and a move that reorders or drops
    // that housekeeping leaves the signature green. MEASURED: before this, the
    // happy-path artifact contained zero reaper and zero queue calls.
    for (const [op, fn] of Object.entries(FALLBACKS)) {
      // LOUD, because the failure it catches is silent. A fallback that is not a
      // function installs nothing, the wrapper below skips it, the daemon reaches
      // past ctx to the production import, and the seam simply never appears --
      // an artifact missing a whole seam looks exactly like a scenario that did
      // not reach it.
      if (typeof fn !== "function")
        throw new Error(`tick-harness: no fallback for the "${op}" seam (got ${typeof fn}); it would run unrecorded`);
      if (typeof ctx[op] !== "function") ctx[op] = fn;
    }
    for (const [op, inner] of Object.entries(ctx)) {
      if (typeof inner !== "function") continue;
      ctx[op] = (...args) => { seams.push({ op, args }); return inner(...args); };
    }
  }
  // ONE VERDICT PER TICK when the caller gives a list. A scenario about a fault
  // that CLEARS needs the containment verdict to differ between ticks, and ctx is
  // built once -- so the alternative was a caller smuggling the sequence in
  // through a getter, which reads as a puzzle and breaks silently the day the
  // tick reads the property a second time. An explicit list per tick cannot.
  const verdictFor = (i) => Array.isArray(containment)
    ? (containment[Math.min(i, containment.length - 1)] ?? null)
    : ctx.containment;

  // THE SAME ctx, N TIMES. Some of what the tick decides is carried on `ctx`
  // between ticks on purpose -- a standing escalation that must not be retired
  // by a quiet tick is the case this was added for -- and a fixture that can only
  // ever run one tick cannot tell a fact that STANDS from one that was merely
  // raised once. `r` is the LAST tick's result, which is the one such a scenario
  // asks about; every tick's escalation map is kept in `all` for a caller that
  // wants to compare them.
  const all = [];
  let r;
  for (let i = 0; i < ticks; i++) {
    if (!containmentThrows) ctx.containment = verdictFor(i);
    r = await tick(ctx);
    all.push(r);
  }
  const out = { r, all, claims, releases, spawned, ctx,
                esc: [...(r.escalations?.keys?.() ?? [])].join(" | "),
                log: readFileSync(join(dir, "log.txt"), "utf8") };
  out.dir = dir;
  out.hubPath = hubPath;
  // Named so a caller can hand it to a second run as `dbPath`.
  out.dbPath = dbPath ?? join(dir, "s.db");
  ctx.db.close();
  try { guest?.close?.(); } catch {}
  // keepDir: the caller dumps the database after the tick, so the directory
  // must outlive this function. It owns the cleanup from there.
  if (!keepDir) rmSync(dir, { recursive: true, force: true });
  return out;
};
