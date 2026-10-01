// Pull requests from forks (#320): their head is a branch of the fork, which the
// base repository doesn't hold, so it's pinned from refs/pull/<n>/head, and their
// repair, which would push to the fork, is left to their author.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as daemon from "../src/daemon.mjs";
import * as reconciler from "../src/github/reconciler.mjs";
import * as pr from "../src/pr.mjs";
import { open } from "../src/db/ops.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { OFFLINE_READS } from "./fixtures/offline-github.mjs";

const SHA = "b".repeat(40);

/** An `ls-remote` that answers every ref with SHA, and keeps the refs it was asked. */
function lsRemote() {
  /** @type {string[]} */ const asked = [];
  const run = (/** @type {string} */ _cmd, /** @type {string[]} */ args) => { asked.push(String(args.at(-1))); return { ok: true, out: `${SHA}\t${args.at(-1)}` }; };
  return { asked, run };
}

test("a fork's pull request is pinned from refs/pull/<n>/head, and one from a branch of the base repository as before", () => {
  const { asked, run } = lsRemote();
  /** @type {any} */ let got;
  try {
    got = [reconciler.pinPrHead("o/r", 7, "fix/x", "fork/r", run), reconciler.pinPrHead("o/r", 7, "fix/x", "O/R", run), reconciler.pinPrHead("o/r", 7, "fix/x", "", run)];
  } catch (err) { got = { threw: String(err) }; }
  assert.ok(Array.isArray(got), JSON.stringify(got));
  assert.ok(got.every((/** @type {any} */ p) => p.ok && p.sha === SHA), JSON.stringify(got));
  // A fork's; the base repository's, its name as GitHub gives it, case aside; and a fork that's gone.
  assert.deepEqual(asked, ["refs/pull/7/head", "refs/heads/fix/x", "refs/pull/7/head"]);
});

test("a fork's pull request is anchored at the head its refs/pull/<n>/head names, and said to be a fork's", () => {
  const { asked, run } = lsRemote();
  /** @type {string[]} */ const read = [];
  const meta = (/** @type {string} */ headRepo) => (/** @type {string[]} */ args) => { read.push(args.join(" ")); return { ok: true, out: ["fix/x", "main", "open", "t", "2026-10-01T00:00:00Z", "someone", headRepo].join("\t") }; };
  const pin = (/** @type {string} */ n, /** @type {number} */ p, /** @type {string} */ h, /** @type {string} */ r) => reconciler.pinPrHead(n, p, h, r, run);
  /** @type {any} */ let fork, own;
  try {
    fork = pr.prAnchor({ nwo: "o/r", pr: 7 }, { read: meta("fork/r"), pin });
    own = pr.prAnchor({ nwo: "o/r", pr: 8 }, { read: meta("o/r"), pin });
  } catch (err) { fork = own = { threw: String(err) }; }
  assert.equal(fork.ok, true, JSON.stringify(fork));
  assert.equal(fork.head, SHA);
  assert.equal(fork.fork, true);
  assert.equal(own.fork, false);
  assert.deepEqual(asked, ["refs/pull/7/head", "refs/heads/fix/x"]);
  assert.match(read[0], /\.head\.repo\.full_name/, "whose repository the head is in is read with the pull request");
});

test("evaluatePr carries a fork's anchor through, so the tick knows the pull request it judged is a fork's", () => {
  const HEAD = "a".repeat(40), BASE = "c".repeat(40);
  const run = (/** @type {string} */ name, /** @type {string} */ conclusion) => JSON.stringify({ name, status: "completed", conclusion, id: 1,
    completed_at: new Date().toISOString(), app: { slug: "github-actions", id: 1 } });
  // gh and git stand-ins on the PATH, as test/evaluate-hands-back-input.test.mjs has them.
  const bin = tempDir("reeve-fork-bin-");
  const page = JSON.stringify({ data: { repository: { pullRequest: { mergeStateStatus: "CLEAN", mergeable: "MERGEABLE", reviewDecision: null,
    reviews: { totalCount: 0 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nfor a in "$@"; do case "$a" in repos/*|graphql) p="$a";; esac; done\ncase "$p" in\n  graphql) echo '${page}';;\n  */check-runs*) echo '${run("CI Gate", "success")}';;\n  */check-suites*) echo '[{"app":{"slug":"github-actions"},"status":"completed"}]';;\n  *) ;;\nesac\n`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = ls-remote ] && printf '%s\\trefs/heads/main\\n' ${BASE}\nexit 0\n`, { mode: 0o755 });
  const db = open(join(tempDir("reeve-fork-db-"), "state.db"));
  const profile = { ci: { requiredChecks: [], reviewerStatusContexts: [] }, reviewers: [] };
  const anchor = (/** @type {boolean} */ fork) => ({ ok: true, headRef: "fix/x", baseRef: "main", state: "OPEN", title: "t", updatedAt: "2026-10-01T00:00:00Z",
                                                     head: HEAD, pin: { ok: true, sha: HEAD }, authorLogin: "someone", fork });
  const path = process.env.PATH;
  /** @type {any[]} */ let got;
  try {
    process.env.PATH = `${bin}:${path}`;
    pr.clearRequirements();
    got = [pr.evaluatePr({ nwo: "o/r", pr: 7, profile, db, anchor: anchor(true) }), pr.evaluatePr({ nwo: "o/r", pr: 7, profile, db, anchor: anchor(false) })];
  } finally { process.env.PATH = path; db.close(); }
  assert.equal(got[0].ok, true, got[0].why);
  assert.equal(got[0].fork, true);
  assert.equal(got[1].fork, false);
  assert.deepEqual(computeVerdict(got[0].input), got[0].verdict, "control: judged as any other");
});

/** A tick whose one pull request, #42, is red on CI and wants a worker to fix it; `fork` where its head is a fork's. */
async function redTick(/** @type {boolean} */ fork) {
  const stateDir = tempDir("rf-");
  const clone = tempDir("rf-clone-");
  execFileSync("git", ["-C", clone, "init", "-q"]);
  const cl = (/** @type {string} */ id, /** @type {string} */ state, detail = "") => ({ id, state, detail });
  const evaluation = { ok: true, pr: 42, state: "open", head: "a".repeat(40), title: "t", headRef: "f", baseRef: "main", fork,
    verdict: { state: "BLOCK", summary: "ci is red",
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"].map((id) => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true } };
  let prepared = 0;
  mkdirSync(stateDir, { recursive: true });
  const ctx = {
    ...OFFLINE_READS,
    nwo: "o/r", db: open(join(stateDir, "e.db")), logPath: join(stateDir, "reeve.log"), dbPath: join(stateDir, "e.db"),
    profile: { identity: { key: "o/r", defaultBranch: "main", worktreeRoot: tempDir("rf-root-"), checkout: clone },
               authority: { policy: "propose_and_merge" }, rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 },
               ci: { provider: "github-actions", requiredChecks: [] }, watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 } },
    execute: true, shadow: true, running: 0,
    capacity: () => ({ allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }),
    containment: { credentialRead: "closed", why: "test" }, keychain: { measured: true, items: [], why: null },
    claudeBin: "/bin/sh", cliVersion: "test",
    openPrs: () => [42], evaluate: () => evaluation, publish: async () => ({ ok: true, id: 1, conclusion: "neutral" }),
    resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", cause: [{ where: "src/x.ts:1", message: "boom" }] }),
    observe: () => ({ ok: false, observations: [], incomplete: true, threads: { readable: false, total: null, unresolved: 0, seen: 0 } }),
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    prepareCheckout: () => { prepared++; return { ok: false, path: null, why: "this test prepares none" }; },
    spawnWorker: async () => ({ outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s1" }),
  };
  await daemon.tick(ctx);
  ctx.db.close();
  return { prepared, logged: readFileSync(ctx.logPath, "utf8") };
}

test("a fork's pull request is never handed to a worker, as its fix couldn't be pushed to the fork, and the log says why", async () => {
  const fork = await redTick(true);
  assert.equal(fork.prepared, 0, "a checkout was prepared for a fork's repair");
  assert.match(fork.logged, /#42: NOT dispatching FIX_CI — its head is a fork's branch, which reeve can't push to/, fork.logged.slice(-1500));
  const own = await redTick(false);
  assert.equal(own.prepared, 1, `control: one from a branch of the base repository is: ${own.logged.slice(-800)}`);
});
