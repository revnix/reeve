// Where a worker runs is decided by identity.worktreeRoot and identity.checkout,
// and every profile written so far set worktreeRoot RELATIVELY
// ("../nextly-worktrees"). A relative path is meaningless to a daemon: launchd
// starts it in WorkingDirectory, so "../nextly-worktrees" resolved to a
// directory that does not exist, while the real one lives under
// nextly-workspace/. With --execute on, every dispatch would have failed with a
// raw ENOENT from spawn.
//
// Worse was the fallback. `?? process.cwd()` meant that with no worktreeRoot at
// all, a worker sent to fix a nextly pull request would have run inside the
// reeve checkout -- the same defect shape as the launchd agent watching the
// wrong repository, and fail-OPEN rather than fail-closed.
//
// Two layers answer that, and both are measured here: the SCHEMA refuses a
// relative root when the profile loads, and DISPATCH refuses to run at all when
// either path is missing.
import { validate, withDefaults } from "../src/profile/schema.mjs";
import { tick } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const real = mkdtempSync(join(tmpdir(), "reeve-wt-"));

const base = {
  schemaVersion: 1,
  project: { kind: "product" },
  identity: { key: "o/r", defaultBranch: "main", visibility: "private" },
  authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
  state: { mode: "in-repo" },
  units: [{ id: "root", root: ".", language: "typescript", packageManager: "pnpm",
            commands: { test: { cmd: "pnpm test", state: "present" } } }],
  ci: { provider: "github-actions", requiredChecks: [] },
  merge: { method: "squash", enforcement: "enforced" },
};
const withRoot = v => { const p = structuredClone(base); p.identity.worktreeRoot = v; return p; };

// --- the schema -------------------------------------------------------------
{
  const r = validate(withDefaults(withRoot(real)));
  check(r.ok, "control: an absolute worktreeRoot validates", r.errors?.join(" | "));
}
{
  const r = validate(withDefaults(withRoot("../nextly-worktrees")));
  const hit = !r.ok && r.errors.some(e => /worktreeRoot.*absolute/i.test(e));
  check(hit, "a relative worktreeRoot is refused when the profile loads",
    r.ok ? "it PASSED" : r.errors.join(" | "));
}
{
  // Absent is allowed by the schema; the refusal to dispatch happens below.
  const r = validate(withDefaults(structuredClone(base)));
  check(r.ok, "an absent worktreeRoot still validates", r.errors?.join(" | "));
}

// --- dispatch ---------------------------------------------------------------
//
// Driven through a whole tick, because the refusal that matters is the one the
// daemon actually makes. A unit test of a resolver proved a function nothing
// called: the resolver is gone, and this is what replaced it.
const HEAD = "a".repeat(40);
const CAUSE = { ok: true, job: "CI Gate", step: "Test", cause: [{ where: "src/x.ts:1", message: "boom" }] };
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

const dispatchProfile = over => ({
  identity: { key: "o/r", defaultBranch: "main", ...over },
  authority: { policy: "propose_and_merge" },
  rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 3 },
  ci: { provider: "github-actions", requiredChecks: [] },
  watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
});

let spawned = [];
const ctxFor = (dir, identity, extra = {}) => ({
  nwo: "o/r", profile: dispatchProfile(identity), db: open(join(dir, "d.db")), logPath: join(dir, "log.txt"),
  execute: true, shadow: true, running: 0,
  // The real capacity() backs off on the host's load average, so a busy machine
  // would fail these assertions for a reason that is not the code.
  capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
  containment: { credentialRead: "closed", why: "test" },
  keychain: { measured: true, items: [], why: null },
  claudeBin: "/bin/sh", cliVersion: "test",
  openPrs: () => [42],
  evaluate: () => evaluation,
  publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
  spawnWorker: async (args) => { spawned.push(args); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s1" }; },
  resolveCause: () => CAUSE,
  ...extra,
});

{
  const dir = mkdtempSync(join(tmpdir(), "reeve-noroot-"));
  spawned = [];
  const r = await tick(ctxFor(dir, { checkout: dir }));      // a clone, but nowhere to put the checkout
  const esc = [...(r.escalations?.keys() ?? [])].join(" | ");
  check(spawned.length === 0 && /worktreeRoot/.test(esc),
    "no worktreeRoot refuses to dispatch rather than falling back to the daemon's cwd", `spawned=${spawned.length} ${esc}`);
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-noclone-"));
  spawned = [];
  const r = await tick(ctxFor(dir, { worktreeRoot: dir }));  // somewhere to put it, but nothing to clone FROM
  const esc = [...(r.escalations?.keys() ?? [])].join(" | ");
  check(spawned.length === 0 && /identity\.checkout/.test(esc),
    "a worktreeRoot with no identity.checkout refuses — a checkout is made FROM a clone", `spawned=${spawned.length} ${esc}`);
  rmSync(dir, { recursive: true, force: true });
}

rmSync(real, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
