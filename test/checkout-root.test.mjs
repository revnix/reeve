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
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
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
  // Injected, never read from disk. The real reader looks at
  // ~/.reeve/claude-token, so a default makes these tests pass on a machine that
  // happens to have one and fail on CI, which is exactly what it did.
  oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
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

// ── a failed backup ESCALATES, and a same-second race does not ──────────────
// `snapshotAll` has always returned an `escalate` key on a failed snapshot and
// NOTHING anywhere consumed it -- measured with a repository-wide grep. So a
// backup that wrote an unreadable file and deleted it produced one log line and
// no finding, and the self-audit could not cover the gap either: the previous
// GOOD snapshot is deliberately retained, so it still looks fresh and reports
// nothing. The failure stayed silent until that retained copy aged out, which
// is exactly the window in which there is no working backup.
//
// `snapshotAll` is injected through ctx, so this needs no real filesystem.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-bkfail-"));
  spawned = [];
  const r = await tick(ctxFor(dir, { worktreeRoot: real, checkout: real }, {
    snapshotAll: () => [{ nwo: "hub", ok: false, outcome: "failed",
                          escalate: "builder:backup:failed",
                          why: "snapshot failed validation and was deleted: not a usable store" }],
  }));
  const esc = [...(r.escalations?.keys() ?? [])].join(" | ");
  check(/builder:backup:failed/.test(esc),
    "a snapshot that fails validation reaches the daemon's escalation path, not only its log",
    esc || "(no escalations)");
  check(/hub/.test(esc),
    "and names the store, so an operator knows which backup is broken", esc);
  rmSync(dir, { recursive: true, force: true });
}
{
  // The other half: a deferred result must NOT raise anything. It is `ok`
  // because another process published that second, and calling a benign
  // multi-daemon race a backup failure is a false alert on the one signal that
  // has to stay trustworthy.
  const dir = mkdtempSync(join(tmpdir(), "reeve-bkdef-"));
  spawned = [];
  const r = await tick(ctxFor(dir, { worktreeRoot: real, checkout: real }, {
    snapshotAll: () => [{ nwo: "hub", ok: true, outcome: "deferred", deferred: true,
                          mine: false, escalate: null,
                          path: "/tmp/x/1.db", why: "another process published it this second" }],
  }));
  const esc = [...(r.escalations?.keys() ?? [])].join(" | ");
  check(!/backup/i.test(esc),
    "a deferred same-second race raises no escalation",
    esc || "(none, as intended)");
  // And says nothing alarming in the LOG either, which is what the defect
  // actually was: `escalate` is null on a deferred result, so an assertion over
  // the escalations map alone stays green while the daemon writes
  // `backup FAILED` on every benign collision. The log is the operator-facing
  // half and it needs its own assertion.
  const logged = readFileSync(join(dir, "log.txt"), "utf8");
  check(!/backup FAILED/.test(logged),
    "control: and does not write `backup FAILED` to the log for a benign collision",
    (logged.split("\n").filter(l => /backup/i.test(l)).join(" | ")) || "(no backup lines)");
  rmSync(dir, { recursive: true, force: true });
}

// ── a backup failure STANDS between attempts ───────────────────────────────
// `escalations` is rebuilt every tick and a backup is attempted once an
// INTERVAL, so the finding existed for exactly one tick and was then absent --
// which the layer below reads as resolved, so an ordinary tick could announce
// CLEARED while no backup had succeeded. The self-audit cannot recreate it
// either: the previous GOOD snapshot is deliberately retained, so it still looks
// fresh.
//
// The control is the one that makes this mean anything: the second tick must NOT
// have retried the backup. If it did, the finding would be re-raised by a fresh
// failure rather than by having stood.
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-bkstand-"));
  spawned = [];
  let attempts = 0;
  const ctx = ctxFor(dir, { worktreeRoot: real, checkout: real }, {
    snapshotAll: () => { attempts++; return [{ nwo: "hub", ok: false, outcome: "failed",
                                               escalate: "builder:backup:failed",
                                               why: "snapshot failed validation and was deleted" }]; },
  });
  const t1 = await tick(ctx);
  check(/builder:backup:failed/.test([...(t1.escalations?.keys() ?? [])].join(" | ")),
    "fixture: the failing tick raises the finding", [...(t1.escalations?.keys() ?? [])].join(" | "));

  const t2 = await tick(ctx);
  check(attempts === 1,
    "control: the next tick does not retry the backup, which is the window this is about",
    `${attempts} attempt(s)`);
  check(/builder:backup:failed/.test([...(t2.escalations?.keys() ?? [])].join(" | ")),
    "the failure still stands on a tick that took no backup at all",
    [...(t2.escalations?.keys() ?? [])].join(" | ") || "(no escalations)");

  // And it clears on a snapshot that is actually TAKEN -- not on a deferred one,
  // which says another process published this second and nothing about whether
  // this daemon can.
  ctx.snapshotAll = () => [{ nwo: "hub", ok: true, outcome: "deferred", deferred: true,
                             mine: false, escalate: null, path: "/tmp/x/1.db", why: "another process" }];
  ctx.lastBackupAt = 0;
  const t3 = await tick(ctx);
  check(/builder:backup:failed/.test([...(t3.escalations?.keys() ?? [])].join(" | ")),
    "a DEFERRED snapshot does not clear it, because it is not this daemon's success",
    [...(t3.escalations?.keys() ?? [])].join(" | ") || "(none)");

  ctx.snapshotAll = () => [{ nwo: "hub", ok: true, outcome: "taken", path: "/tmp/x/2.db" }];
  ctx.lastBackupAt = 0;
  const t4 = await tick(ctx);
  check(!/backup/i.test([...(t4.escalations?.keys() ?? [])].join(" | ")),
    "and a snapshot that IS taken clears it",
    [...(t4.escalations?.keys() ?? [])].join(" | ") || "(none, as intended)");

  const t5 = await tick(ctx);
  check(!/backup/i.test([...(t5.escalations?.keys() ?? [])].join(" | ")),
    "control: and it stays cleared on the tick after that, so clearing is not one-shot either",
    [...(t5.escalations?.keys() ?? [])].join(" | ") || "(none, as intended)");
  rmSync(dir, { recursive: true, force: true });
}

rmSync(real, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
