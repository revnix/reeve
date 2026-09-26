// A PASS reeve can no longer stand behind is taken back (#161).
//
// Reeve republishes its verdict on every tick, so while ticks run a PASS stays
// current. When reeve can't re-check a pull request it withdraws the PASS
// instead: on HALT, on a stop, for a pull request whose read failed or that is
// past the number it watches, and when a new verdict couldn't be published over
// one. Withdrawing marks the check cancelled, which a required check reads as
// not passed. Each case here runs ticks against a fake publisher and
// withdrawer, and a store of its own.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as daemon from "../src/daemon.mjs";
import * as pr from "../src/pr.mjs";
import { open } from "../src/db/ops.mjs";
import { statePathFor } from "../src/paths.mjs";
import { withDefaults } from "../src/profile/schema.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NWO = "acme/widget";
const headOf = (n) => String(n).repeat(40).slice(0, 40);

// An evaluation that pins `pr` at its head with `state`, as evaluatePr returns one.
const evaluation = (n, state = "PASS", clauses = []) => ({ ok: true, pr: n, state: "open", head: headOf(n), title: "t", headRef: `f${n}`,
  baseRef: "main", updatedAt: "2026-09-26T10:00:00Z", verdict: { state, head: headOf(n), summary: state.toLowerCase(), clauses },
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 }, checks: { verdict: "GREEN", caused: [], failing: [] },
  reviewers: [], threads: { readable: true, total: 0, unresolved: 0, seen: 0 }, settled: { settled: true } });

// A tick's context: `evaluate` and `openPrs` as given, a publisher that
// succeeds, and a withdrawer that records what it takes back.
const setup = ({ cap = 20, publish = null, withdraw = null } = {}) => {
  const dir = tempDir("reeve-withdraw-");
  const published = [], withdrawn = [];
  const ctx = {
    nwo: NWO, profile: { identity: { key: NWO, defaultBranch: "main" }, authority: { policy: "propose_only" },
      ci: { provider: "github-actions", requiredChecks: [] }, watch: { maxWorkers: 1, maxOpenPrs: cap }, reviewers: [] },
    db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"), haltMarker: join(dir, "HALT"),
    execute: false, shadow: false, running: 0,
    openPrs: () => [7, 8], evaluate: ({ pr: n }) => evaluation(n),
    publish: publish ?? (async (args) => { published.push(args); return { ok: true, id: 100 + args.verdict.head.charCodeAt(0), conclusion: "success", name: "ops/merge-policy" }; }),
    withdraw: withdraw ?? (async (args) => { withdrawn.push(args); return { ok: true }; }),
    observe: () => ({ observations: [], incomplete: false, threads: { readable: true, total: 0, unresolved: 0, seen: 0 } }),
    derivePr: () => ({}), reviewState: () => ({ readable: true, total: 0, open: 0, resolved: 0, unspilledCritical: 0, rounds: 1 }),
  };
  return { dir, ctx, published, withdrawn, halt: () => writeFileSync(ctx.haltMarker, "") };
};
// The pull requests a list of publishes or withdrawals was for, by the head each named.
const prsOf = (calls) => calls.map((c) => (c.head ?? c.verdict?.head)[0]).map(Number).sort();
const escalated = (t, re) => [...(t.escalations?.keys?.() ?? [])].filter((cause) => re.test(cause));

test("a halted tick withdraws every PASS reeve has standing, and a second withdraws nothing more", async () => {
  const { ctx, withdrawn, halt } = setup();
  await daemon.tick(ctx);
  halt();
  const first = await daemon.tick(ctx);
  assert.equal(first.halted, true);
  assert.deepEqual(prsOf(withdrawn), [7, 8], JSON.stringify(withdrawn));
  assert.ok(withdrawn.every((w) => w.name === "ops/merge-policy" && /halted/.test(w.why)), JSON.stringify(withdrawn));
  await daemon.tick(ctx);
  assert.equal(withdrawn.length, 2, "nothing is left standing to withdraw");
});

test("a pull request reeve couldn't re-check has its PASS withdrawn, and one it re-checked keeps it", async () => {
  const { ctx, withdrawn } = setup();
  await daemon.tick(ctx);
  // #7's head can't be read; #8 is re-checked and published again.
  await daemon.tick({ ...ctx, evaluate: ({ pr: n }) => (n === 7 ? { ok: false, why: "GitHub answered 502" } : evaluation(n)) });
  assert.deepEqual(prsOf(withdrawn), [7], JSON.stringify(withdrawn));

  // Its head read, #7's evaluation fails.
  const late = setup();
  await daemon.tick(late.ctx);
  await daemon.tick({ ...late.ctx, prAnchor: ({ pr: n }) => ({ ok: true, head: headOf(n), headRef: `f${n}`, updatedAt: "2026-09-26T10:00:00Z" }),
    evaluate: ({ pr: n }) => (n === 7 ? { ok: false, why: "GitHub answered 502" } : evaluation(n)) });
  assert.deepEqual(prsOf(late.withdrawn), [7], JSON.stringify(late.withdrawn));
});

test("a tick that can't list the pull requests re-checks none of them, and withdraws every PASS", async () => {
  const { ctx, withdrawn } = setup();
  await daemon.tick(ctx);
  const t = await daemon.tick({ ...ctx, openPrs: () => null });
  assert.equal(t.unreadable, true);
  assert.deepEqual(prsOf(withdrawn), [7, 8], JSON.stringify(withdrawn));
  assert.ok(withdrawn.every((w) => /pull requests/.test(w.why)), JSON.stringify(withdrawn));
});

test("a pull request past the number reeve watches has its PASS withdrawn, and one that closed is left alone", async () => {
  const atCap = setup({ cap: 2 });
  await daemon.tick(atCap.ctx);
  // At the cap, #7 and #8 may be open beyond it.
  await daemon.tick({ ...atCap.ctx, openPrs: () => [9, 10] });
  assert.deepEqual(prsOf(atCap.withdrawn), [7, 8], JSON.stringify(atCap.withdrawn));

  const underCap = setup({ cap: 5 });
  await daemon.tick(underCap.ctx);
  // Under the cap, every open pull request is listed: #7 closed.
  await daemon.tick({ ...underCap.ctx, openPrs: () => [8] });
  underCap.halt();
  await daemon.tick(underCap.ctx);
  assert.deepEqual(prsOf(underCap.withdrawn), [8], "only #8, halted: #7's PASS stands on nothing open");
});

test("a publish that throws doesn't end the tick: the pull requests after it are still published", async () => {
  const published = [];
  const { ctx } = setup({ publish: async (args) => {
    if (args.verdict.head.startsWith("7")) throw new Error("fetch failed");
    published.push(args); return { ok: true, id: 1, conclusion: "success", name: "ops/merge-policy" };
  } });
  let threw = null;
  try { await daemon.tick(ctx); } catch (err) { threw = err.message; }
  assert.equal(threw, null, "the tick itself threw");
  assert.deepEqual(prsOf(published), [8]);
  assert.match(readFileSync(ctx.logPath, "utf8"), /#?7[\s\S]*could not publish: [^\n]*fetch failed/);
});

test("a PASS that no longer holds is withdrawn when the new verdict can't be published, and a person is told at once if it can't be", async () => {
  const { ctx, withdrawn } = setup();
  await daemon.tick(ctx);
  // #7 is now blocked at the same head, and its publication fails.
  const blocked = { ...ctx, evaluate: ({ pr: n }) => evaluation(n, n === 7 ? "BLOCK" : "PASS"),
    publish: async (args) => (args.verdict.head.startsWith("7") ? { ok: false, why: "HTTP 502" } : { ok: true, id: 1, conclusion: "success", name: "ops/merge-policy" }) };
  await daemon.tick(blocked);
  assert.deepEqual(prsOf(withdrawn), [7], JSON.stringify(withdrawn));

  const stuck = setup();
  await daemon.tick(stuck.ctx);
  const t = await daemon.tick({ ...stuck.ctx, evaluate: ({ pr: n }) => evaluation(n, n === 7 ? "BLOCK" : "PASS"),
    publish: async (args) => (args.verdict.head.startsWith("7") ? { ok: false, why: "HTTP 502" } : { ok: true, id: 1, conclusion: "success", name: "ops/merge-policy" }),
    withdraw: async () => ({ ok: false, why: "HTTP 502" }) });
  assert.equal(escalated(t, /#7: .*PASS.*couldn't withdraw/).length, 1, JSON.stringify([...t.escalations.keys()]));
});

test("publishing that keeps failing is raised for a person, and a publication in between starts the count again", async () => {
  // Every publication fails but the third.
  let calls = 0;
  const { ctx } = setup({ publish: async () => (++calls > 4 && calls <= 6 ? { ok: true, id: 1, conclusion: "success", name: "ops/merge-policy" } : { ok: false, why: "HTTP 502" }) });
  const ticks = [];
  for (let n = 0; n < 6; n++) ticks.push(await daemon.tick(ctx));
  assert.equal(escalated(ticks[1], /couldn't publish/).length, 0, "not after two");
  // The third tick publishes, so after two more failures the count is two.
  assert.equal(escalated(ticks[4], /couldn't publish/).length, 0, JSON.stringify([...ticks[4].escalations.keys()]));
  assert.equal(escalated(ticks[5], /#7: .*couldn't publish/).length, 1, JSON.stringify([...ticks[5].escalations.keys()]));
});

test("the stuck-UNKNOWN alert reads the decisions by time, not the last 30", async () => {
  const { ctx } = setup();
  ctx.openPrs = () => [7];
  const unknown = { id: "review", state: "UNKNOWN", detail: "the reviewer hasn't answered" };
  // Two hours of UNKNOWN decisions, one every 90 seconds: 80 of them.
  const start = Math.floor(Date.now() / 1000) - 7200;
  const insert = ctx.db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)");
  for (let n = 0; n < 80; n++)
    insert.run(start + n * 90, "daemon", "pr.decided", "pr:7", JSON.stringify({ head: headOf(7), state: "UNKNOWN", clauses: [{ id: "review", state: "UNKNOWN" }] }));
  const t = await daemon.tick({ ...ctx, evaluate: ({ pr: n }) => evaluation(n, "UNKNOWN", [unknown]) });
  assert.equal(t.decisions[0]?.decision.action, "ESCALATE", JSON.stringify(t.decisions[0]?.decision));
});

test("a BLOCK that carries an UNKNOWN clause counts as UNKNOWN for that alert", async () => {
  const { ctx } = setup();
  ctx.openPrs = () => [7];
  const start = Math.floor(Date.now() / 1000) - 7200;
  const insert = ctx.db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)");
  for (let n = 0; n < 5; n++)
    insert.run(start + n * 1500, "daemon", "pr.decided", "pr:7", JSON.stringify({ head: headOf(7), state: "BLOCK", clauses: [{ id: "review", state: "UNKNOWN" }] }));
  const unknown = { id: "review", state: "UNKNOWN", detail: "the reviewer hasn't answered" };
  const t = await daemon.tick({ ...ctx, evaluate: ({ pr: n }) => evaluation(n, "UNKNOWN", [unknown]) });
  assert.equal(t.decisions[0]?.decision.action, "ESCALATE", JSON.stringify(t.decisions[0]?.decision));
});

test("a withdrawal cancels reeve's own run at that head, which a required check reads as not passed", async () => {
  assert.equal(typeof pr.withdrawVerdict, "function");
  const calls = [];
  const api = (_token, args) => {
    calls.push(args);
    if (args.some((a) => /check-runs\?/.test(a))) return { ok: true, out: JSON.stringify({ name: "ops/merge-policy", id: 55, conclusion: "success", app: "merge-policy" }) };
    return { ok: true, out: JSON.stringify({ id: 55 }) };
  };
  const auth = async () => ({ ok: true, token: "t" });
  const byId = await pr.withdrawVerdict({ nwo: NWO, head: headOf(7), name: "ops/merge-policy", id: 55, why: "the merge policy is halted", auth, api });
  assert.equal(byId.ok, true);
  const patch = calls.find((a) => a.includes("PATCH"));
  assert.ok(patch?.includes(`repos/${NWO}/check-runs/55`) && patch.includes("status=completed") && patch.includes("conclusion=cancelled")
    && patch.some((a) => /^output\[title\]=Withdrawn: the merge policy is halted/.test(a)), JSON.stringify(calls));
  // With no id, reeve's own run under the name at the head is looked up.
  calls.length = 0;
  const looked = await pr.withdrawVerdict({ nwo: NWO, head: headOf(7), name: "ops/merge-policy", id: null, why: "the merge policy stopped", auth, api });
  assert.ok(looked.ok && calls.some((a) => a.includes(`repos/${NWO}/check-runs/55`)), JSON.stringify(calls));
  const failed = await pr.withdrawVerdict({ nwo: NWO, head: headOf(7), name: "ops/merge-policy", id: 55, why: "x", auth, api: () => ({ ok: false, err: "HTTP 502\nmore" }) });
  assert.deepEqual(failed, { ok: false, why: "HTTP 502" });
});

// ── a stopped daemon, and the one systemd runs after it ────────────────────────
// Each runs the real CLI from a scratch home with a store holding a PASS on #7,
// and no App credentials, so nothing reaches GitHub: the withdrawal is tried,
// and fails for want of a key, which is what the log shows.
const scratchHome = () => {
  const home = tempDir("reeve-withdraw-home-");
  const db = statePathFor(home, NWO);
  mkdirSync(dirname(db), { recursive: true });
  const store = open(db);
  store.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(Math.floor(Date.now() / 1000), "daemon", "pr.published", "pr:7", JSON.stringify({ head: headOf(7), state: "PASS", name: "ops/merge-policy", id: 55 }));
  store.close?.();
  mkdirSync(join(home, "profiles", "acme"), { recursive: true });
  writeFileSync(join(home, "profiles", "acme", "widget.json"), JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: NWO, defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] })));
  return home;
};

test("a stopped daemon tries to withdraw every PASS it has standing before it exits", async () => {
  const home = scratchHome();
  writeFileSync(join(home, "HALT"), "");   // every tick returns at once
  const child = spawn(process.execPath, [join(ROOT, "bin", "reeve"), "run", NWO, "--interval", "600"],
    { cwd: home, env: { ...process.env, REEVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  try {
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    for (let n = 0; n < 300 && !/halted — sleeping/.test(out); n++) await new Promise((r) => setTimeout(r, 100));
    child.kill("SIGTERM");
    assert.equal(await exited, 0, out.slice(-600));
    const stopping = out.slice(out.indexOf("SIGTERM"));
    assert.match(stopping, /#7[^\n]*withdraw[^\n]*merge policy stopped/i, stopping.slice(0, 600));
    assert.ok(stopping.indexOf("#7") < stopping.indexOf("daemon stopped"), stopping.slice(0, 600));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("reeve withdraw, which systemd runs after the daemon however it stopped, tries every PASS left standing and says which failed", () => {
  const home = scratchHome();
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), "withdraw", NWO],
    { cwd: home, env: { ...process.env, REEVE_HOME: home }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.match(`${r.stdout}${r.stderr}`, /#7/);
  const unit = readFileSync(join(ROOT, "deploy", "reeve.service"), "utf8");
  const start = /^ExecStart=(\S+) (\S+) run (\S+)$/m.exec(unit), after = /^ExecStopPost=(\S+) (\S+) withdraw (\S+)$/m.exec(unit);
  assert.ok(start && after && start[1] === after[1] && start[2] === after[2] && start[3] === after[3],
    "ExecStopPost runs the same node and reeve on the same repository as ExecStart");
});
