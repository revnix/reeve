// The daemon's word on a push whose outcome isn't known (#284): stopped at the
// network bound, and the remote unreadable after, a fix may have been published,
// so it's never escalated as one that couldn't be.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tick } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { OFFLINE_READS } from "./fixtures/offline-github.mjs";

const HEAD = "a".repeat(40);
const cl = (/** @type {string} */ id, /** @type {string} */ state, detail = "") => ({ id, state, detail });

/** A dispatch tick over #42, its CI red, whose worker leaves a fix, and whose publication answers as `publishWork` does. */
async function dispatch(/** @type {(o: any) => any} */ publishWork) {
  const dir = tempDir("reeve-push-unknown-");
  const clone = tempDir("reeve-push-unknown-clone-");
  execFileSync("git", ["-C", clone, "init", "-q"]);
  execFileSync("git", ["-C", clone, "config", "user.name", "Founder"]);
  execFileSync("git", ["-C", clone, "config", "user.email", "founder@example.invalid"]);
  // The run's checkout: branch f at a seed commit, and the worker's fix beside it, uncommitted, for reeve to commit.
  const wt = mkdtempSync(join(dir, "wt-"));
  execFileSync("git", ["-C", wt, "init", "-q", "-b", "f"]);
  writeFileSync(join(wt, "seed.js"), "seed\n");
  execFileSync("git", ["-C", wt, "add", "-A"]);
  execFileSync("git", ["-C", wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "seed"]);
  const pinned = execFileSync("git", ["-C", wt, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(wt, "fix.js"), "the fix\n");
  const profile = {
    identity: { key: "o/r", defaultBranch: "main", worktreeRoot: dir, checkout: clone },
    authority: { policy: "propose_and_merge" },
    rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
    ci: { provider: "github-actions", requiredChecks: [] },
    watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 },
  };
  const evaluation = {
    ok: true, pr: 42, state: "open", head: pinned, title: "t", headRef: "f", baseRef: "main",
    verdict: { state: "BLOCK", summary: "ci is red",
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"].map((id) => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true },
  };
  const logPath = join(dir, "log.txt");
  const db = open(join(dir, "d.db"));
  try {
    const r = await tick({
      ...OFFLINE_READS,
      nwo: "o/r", profile, db, logPath, execute: true, shadow: true, running: 0,
      capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
      containment: { credentialRead: "closed", why: "test" },
      keychain: { measured: true, items: [], why: null },
      claudeBin: "/bin/sh", cliVersion: "test",
      openPrs: () => [42],
      evaluate: () => evaluation,
      publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
      spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s",
                                  report: { fixed: true, cause: "c", change: "ch", filesTouched: ["fix.js"] } }),
      resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", cause: [{ where: "src/x.ts:1", message: "boom" }] }),
      observe: () => ({ ok: false, observations: [], incomplete: true, threads: { readable: false, total: null, unresolved: 0, seen: 0 } }),
      oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
      prepareCheckout: () => ({ ok: true, path: wt, why: null, deps: { ok: true, cow: false } }),
      verifyConfig: () => ({ ok: true, why: null }),
      publishWork,
    });
    return { escalations: [...r.escalations.keys()].join(" | "), log: readFileSync(logPath, "utf8") };
  } finally { db.close(); }
}

test("a fix whose push isn't known to have landed is escalated as not known, not as unpublished", async () => {
  let asked = 0;
  const { escalations, log } = await dispatch(() => { asked++; return { ok: false, unknown: true, why: "the push didn't answer within 60 seconds, and whether it landed isn't known: the remote couldn't be read" }; });
  assert.equal(asked, 1, `control: it was published: ${log}`);
  assert.match(escalations, /#42: a fix was produced, and whether it was published isn't known/);
  assert.doesNotMatch(escalations, /could not be published/);
});

test("control: a fix whose push wasn't published is escalated as that", async () => {
  const { escalations } = await dispatch(() => ({ ok: false, why: "push refused: rejected" }));
  assert.match(escalations, /#42: a fix was produced but could not be published — push refused: rejected/);
});
