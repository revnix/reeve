// flakeEvidence existed, was documented, and was called by NOTHING -- so on a
// base that is red 6 of its last 9 runs, arming --execute would pay a worker to
// "fix" randomness and then page the founder about a failure that never existed.
//
// The rule being wired: only DEMONSTRATION changes the decision. A job that both
// passed and failed across attempts of one run is a flake by demonstration; a
// job that merely cannot be assessed (no runId -- commit statuses) is assumed
// deterministic, because treating "cannot check" as "flaky" would let every
// unreadable failure skip its fixer -- absence of evidence is not flake evidence.
import { tick } from "../src/daemon.mjs";
import { flakeAssessment, causeKey } from "../src/ci-rootcause.mjs";
import { open, countFixAttempts } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── the unit: what counts as demonstrated ────────────────────────────────────
{
  let probed = 0;
  const flakyProbe = () => { probed++; return { flake: true, why: "passed and failed" }; };

  // No runId: the probe must not even be consulted.
  const a = flakeAssessment("o/r", { ok: true, job: "J", cause: [] }, flakyProbe);
  check(a.flaky.length === 0 && a.real.length === 1 && probed === 0,
    "a part with no runId is assumed deterministic and never probed", JSON.stringify(a));

  const b = flakeAssessment("o/r", { ok: true, job: "J", runId: 7, cause: [] }, flakyProbe);
  check(b.allFlaky === true && b.flaky.length === 1,
    "a probed single-part cause can be wholly flaky", JSON.stringify(b));

  const merged = { ok: true, job: "A, B", runId: 7, parts: [
    { job: "A", runId: 7 }, { job: "B", runId: 7 }] };
  const c = flakeAssessment("o/r", merged, (n, r, j) => ({ flake: j === "A" }));
  check(c.flaky.length === 1 && c.real.length === 1 && c.allFlaky === false,
    "a merged cause splits into flaky and real parts", JSON.stringify(c));

  check(flakeAssessment("o/r", null, flakyProbe).allFlaky === false,
    "no cause at all is NOT wholly flaky — absence is never a result");
}

// ── the wiring: a whole tick, collaborators stubbed at the daemon's seams ────
const HEAD = "a".repeat(40);
const cl = (id, state, detail = "") => ({ id, state, detail });
const evalFor = failing => ({
  ok: true, pr: 42, state: "open", head: HEAD, title: "t", headRef: "f", baseRef: "main",
  verdict: { state: "BLOCK", summary: "ci is red",
             clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"]
               .map(id => (id === "ci" ? cl("ci", "BLOCK", `failing: ${failing.map(f => f.name).join(", ")}`) : cl(id, "PASS"))) },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  checks: { verdict: "RED", caused: failing.map(f => f.name), failing },
  reviewers: [], threads: {}, settled: { settled: true },
});

const CAUSES = {
  "Flaky Check": { ok: true, job: "Flaky Job", step: "t", runId: 11, attempt: 2,
                   cause: [{ where: "t.ts:1", message: "timeout waiting for server" }] },
  "Real Check":  { ok: true, job: "Real Job", step: "t", runId: 11, attempt: 2,
                   cause: [{ where: "x.ts:1", message: "assertion failed: boom" }] },
};

const scenario = async ({ failing, probe }) => {
  const dir = mkdtempSync(join(tmpdir(), "reeve-flake-"));
  const spawned = [];
  const ctx = {
    nwo: "o/r", db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"),
    execute: true, shadow: true, running: 0, containment: { credentialRead: "closed", why: "test" }, keychain: { measured: true, items: [], why: null }, claudeBin: "/bin/sh", cliVersion: "test",
    // Deterministic: the real capacity() backs off on the host's load average, so
    // a busy machine would fail these assertions for a reason that is not the code.
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    profile: {
      // Separate directories, as a real deployment must have them: the worker
      // policy denies reads of the clone, so a checkout inside it is refused.
      identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: mkdtempSync(join(tmpdir(), "reeve-flake-clone-")) },
      authority: { policy: "propose_and_merge" },
      rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
      ci: { provider: "github-actions", requiredChecks: [] },
      watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
    },
    openPrs: () => [42],
    evaluate: () => evalFor(failing),
    publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    spawnWorker: async args => { spawned.push(args); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s" }; },
    // Injected, never read from disk: the real reader looks at
    // ~/.reeve/claude-token, so a default passes on a machine that happens to
    // have one and fails on CI.
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    resolveCause: (nwo, f) => CAUSES[f.name],
    flakeProbe: probe,
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
  };
  const r = await tick(ctx);
  const out = { r, spawned, db: ctx.db,
    esc: [...(r.escalations?.keys?.() ?? [])].join(" | "),
    prompt: JSON.stringify(spawned) };
  rmSync(dir, { recursive: true, force: true });
  return out;
};

// Control: a deterministic failure still dispatches. The probe answering
// "no evidence" must change nothing.
{
  const s = await scenario({ failing: [{ name: "Real Check", id: "1" }],
                             probe: () => ({ flake: false, why: "consistent" }) });
  check(s.spawned.length === 1, "control: a deterministic failure dispatches a fixer", s.esc);
  check(!/demonstrated flake/.test(s.esc), "and raises no flake escalation", s.esc);
  s.db.close();
}

// Every failing part demonstrated flaky: no worker, no attempt spent, one
// escalation whose KEY carries no run ids or counts -- those go to the log.
{
  const s = await scenario({ failing: [{ name: "Flaky Check", id: "2" }],
                             probe: () => ({ flake: true, why: "passed and failed across attempts" }) });
  check(s.spawned.length === 0, "a wholly-flaky failure dispatches NO worker", s.prompt);
  check(/demonstrated flake/.test(s.esc), "and escalates saying why", s.esc);
  check(!/11|attempt/.test(s.esc), "the escalation key is an identity — no run ids, no counts", s.esc);
  const fp = causeKey("o/r", CAUSES["Flaky Check"]);
  check(countFixAttempts(s.db, "o/r", 42, fp) === 0,
    "and no fix attempt was spent on a failure nobody will fix", String(countFixAttempts(s.db, "o/r", 42, fp)));
  s.db.close();
}

// Mixed: the real failure still gets its fixer, and the worker is TOLD which
// job is noise so its budget goes to the failure that exists.
{
  const s = await scenario({ failing: [{ name: "Flaky Check", id: "2" }, { name: "Real Check", id: "1" }],
                             probe: (n, r, job) => ({ flake: job === "Flaky Job" }) });
  check(s.spawned.length === 1, "a mixed failure still dispatches for the real part", s.esc);
  check(/demonstrated flake/.test(s.prompt) && /Flaky Job/.test(s.prompt),
    "and the prompt names the flaky job as noise", s.prompt.slice(0, 400));
  check(/Real Job/.test(s.prompt), "while the real job stays in the work order");
  s.db.close();
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
