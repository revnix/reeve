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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    openPrs: () => [7, 8], evaluate: ({ pr: n }) => evaluation(n), prState: () => "OPEN",
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
// Methods bound to the real object, which node:sqlite's handles need.
const bound = (target, key) => { const v = target[key]; return typeof v === "function" ? v.bind(target) : v; };
// The store, but an event it's asked to write for which `refuse(op, subject)`
// holds fails, as a full or read-only disk would.
const refusing = (db, refuse) => new Proxy(db, { get: (target, key) => key !== "prepare" ? bound(target, key) : (sql) => {
  const st = target.prepare(sql);
  if (!/INSERT INTO event/.test(sql)) return st;
  return new Proxy(st, { get: (s, k) => k !== "run" ? bound(s, k)
    : (...a) => { if (refuse(a[2], a[3])) throw new Error("database or disk is full"); return s.run(...a); } });
} });
// The store, but a read of what reeve has published fails.
const unreadable = (db, when = () => true) => new Proxy(db, { get: (target, key) => key !== "prepare" ? bound(target, key) : (sql) => {
  if (/SELECT/.test(sql) && /pr\.published/.test(sql) && when(sql)) throw new Error("database disk image is malformed");
  return target.prepare(sql);
} });

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

test("a pull request past the number reeve watches has its PASS withdrawn, and one that merged is left alone", async () => {
  const atCap = setup({ cap: 2 });
  await daemon.tick(atCap.ctx);
  // At the cap, #7 and #8 are open beyond it.
  await daemon.tick({ ...atCap.ctx, openPrs: () => [9, 10] });
  assert.deepEqual(prsOf(atCap.withdrawn), [7, 8], JSON.stringify(atCap.withdrawn));

  const merged = setup({ cap: 5 });
  await daemon.tick(merged.ctx);
  // #7 merged. Its PASS is the record of why, and a merged pull request can't reopen.
  await daemon.tick({ ...merged.ctx, openPrs: () => [8], prState: () => "MERGED" });
  merged.halt();
  await daemon.tick(merged.ctx);
  assert.deepEqual(prsOf(merged.withdrawn), [8], "only #8, halted: #7 merged under its PASS");
});

test("a pull request that closed without merging has its PASS withdrawn, so reopening it can't merge on it", async () => {
  const closed = setup({ cap: 5 });
  await daemon.tick(closed.ctx);
  await daemon.tick({ ...closed.ctx, openPrs: () => [8], prState: () => "CLOSED" });
  // Reopened at the same head, and its first read fails: nothing of reeve's passes there.
  await daemon.tick({ ...closed.ctx, evaluate: ({ pr: n }) => (n === 7 ? { ok: false, why: "GitHub answered 502" } : evaluation(n)) });
  assert.deepEqual(prsOf(closed.withdrawn), [7], JSON.stringify(closed.withdrawn));
  assert.ok(closed.withdrawn.every((w) => /closed/.test(w.why)), JSON.stringify(closed.withdrawn));

  // Its state couldn't be read, so it may have closed, or be open and unwatched.
  const unread = setup({ cap: 5 });
  await daemon.tick(unread.ctx);
  await daemon.tick({ ...unread.ctx, openPrs: () => [8], prState: () => null });
  assert.deepEqual(prsOf(unread.withdrawn), [7], JSON.stringify(unread.withdrawn));
});

test("a PASS is written down before it's published, so no crash in between leaves one reeve doesn't know about", async () => {
  const seen = [];
  const { ctx } = setup({ publish: async (args) => {
    seen.push({ pr: Number(args.verdict.head[0]), standing: daemon.standingPasses(ctx.db).map((s) => s.pr) });
    return { ok: true, id: 1, conclusion: "success", name: "ops/merge-policy" };
  } });
  await daemon.tick(ctx);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.standing.includes(s.pr)), JSON.stringify(seen));
});

test("a PASS the store won't take isn't left standing, and says why", async () => {
  const { ctx, published, withdrawn } = setup();
  ctx.db = refusing(ctx.db, (op, subject) => op === "pr.published" && subject === "pr:7");
  await daemon.tick(ctx);
  const sevens = published.filter((p) => p.verdict.head.startsWith("7") && p.verdict.state === "PASS");
  assert.ok(sevens.length === 0 || withdrawn.some((w) => w.head.startsWith("7")), JSON.stringify({ published: prsOf(published), withdrawn }));
  assert.deepEqual(prsOf(published).filter((n) => n === 8), [8], "#8 is published as ever");
  assert.match(readFileSync(ctx.logPath, "utf8"), /#?7[\s\S]*could not publish: [^\n]*written down/);
});

test("reeve that can't read what it has standing says so, rather than reporting that nothing stands", async () => {
  const { ctx } = setup();
  await daemon.tick(ctx);
  const left = await daemon.withdrawStanding({ ...ctx, db: unreadable(ctx.db) }, "the merge policy stopped");
  assert.ok(left.length > 0, "an unreadable store read as nothing standing");
});

test("one record reeve can't read doesn't hide the rest: each PASS it can read is withdrawn, and the other is reported", async () => {
  const { ctx, withdrawn } = setup();
  await daemon.tick(ctx);
  ctx.db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(Math.floor(Date.now() / 1000), "daemon", "pr.published", "pr:9", "{not json");
  const left = await daemon.withdrawStanding(ctx, "the merge policy stopped");
  assert.deepEqual(prsOf(withdrawn), [7, 8], JSON.stringify(withdrawn));
  assert.equal(left.length, 1, JSON.stringify(left));
  assert.match(String(left[0]), /#9\b/);
});

test("standing reeve can't read is raised for a person: at a pull request it can't re-check, and among those it didn't list", async () => {
  const { ctx } = setup();
  await daemon.tick(ctx);
  const t = await daemon.tick({ ...ctx, db: unreadable(ctx.db),
    evaluate: ({ pr: n }) => (n === 7 ? { ok: false, why: "GitHub answered 502" } : evaluation(n)) });
  assert.equal(escalated(t, /#7: .*PASS/).length, 1, JSON.stringify([...t.escalations.keys()]));
  assert.equal(escalated(t, /couldn't read which PASSes/).length, 1, JSON.stringify([...t.escalations.keys()]));
});

test("a verdict that replaces a PASS is written down, so HALT doesn't withdraw what no longer passes", async () => {
  const { ctx, withdrawn, halt } = setup();
  await daemon.tick(ctx);
  // #7 is blocked now, and that is published over its PASS.
  const blocked = { ...ctx, evaluate: ({ pr: n }) => evaluation(n, n === 7 ? "BLOCK" : "PASS") };
  await daemon.tick(blocked);
  halt();
  await daemon.tick(blocked);
  assert.deepEqual(prsOf(withdrawn), [8], JSON.stringify(withdrawn));
});

test("a PASS reeve couldn't withdraw is told even when the store can't record that it was", () => {
  const logPath = join(tempDir("reeve-withdraw-told-"), "log.txt");
  const db = new Proxy({}, { get: () => () => { throw new Error("database disk image is malformed"); } });
  const sent = [];
  daemon.tellStuck({ nwo: NWO, db, logPath, profile: null, notify: ({ alert }) => { sent.push(alert); return { ok: true }; } },
    ["#7: a PASS reeve published may no longer hold, and reeve couldn't withdraw it"]);
  assert.equal(sent.length, 1, "nobody was told");
  assert.match(sent[0].message, /#7: /);
});

test("a PASS reeve couldn't withdraw on HALT is pushed to a person, at the top of a tick and midway through one", async () => {
  const fail = async () => ({ ok: false, why: "HTTP 502" });
  const top = setup({ withdraw: fail });
  const sent = [];
  top.ctx.notify = ({ alert }) => { sent.push(alert); return { ok: true }; };
  await daemon.tick(top.ctx);
  top.halt();
  await daemon.tick(top.ctx);
  assert.ok(sent.some((a) => /#7: [^\n]*PASS[^\n]*couldn't withdraw/.test(a.message)), JSON.stringify(sent));

  const mid = setup({ withdraw: fail });
  const told = [];
  mid.ctx.notify = ({ alert }) => { told.push(alert); return { ok: true }; };
  await daemon.tick(mid.ctx);
  // HALT arrives while #7 is being checked, so the tick stops at #8.
  const t = await daemon.tick({ ...mid.ctx, evaluate: ({ pr: n }) => { if (n === 7) mid.halt(); return evaluation(n); } });
  assert.equal(t.halted, true);
  assert.ok(told.some((a) => /#8: [^\n]*PASS[^\n]*couldn't withdraw/.test(a.message)), JSON.stringify(told));
});

test("a HALT that arrives while the last pull request is checked withdraws every PASS in that tick", async () => {
  const { ctx, withdrawn, halt } = setup();
  // HALT arrives while #8, the last, is being checked: no pull request is left to see it.
  const t = await daemon.tick({ ...ctx, evaluate: ({ pr: n }) => { if (n === 8) halt(); return evaluation(n); } });
  assert.equal(t.halted, true);
  assert.deepEqual(prsOf(withdrawn), [7, 8], JSON.stringify(withdrawn));
  assert.ok(withdrawn.every((w) => /halted/.test(w.why)), JSON.stringify(withdrawn));
});

test("a HALT that arrives just before a worker would start withdraws every PASS too", async () => {
  const { dir, ctx, withdrawn, halt } = setup();
  // #42's CI is red, so a fixer is wanted; #43 passes. HALT arrives as capacity
  // is weighed, the step before a worker would start.
  const red = { ...evaluation(42, "BLOCK", [{ id: "ci", state: "BLOCK", detail: "failing: CI Gate" }]),
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] } };
  const spawned = [];
  await daemon.tick({ ...ctx, execute: true, openPrs: () => [42, 43],
    profile: { ...ctx.profile, identity: { ...ctx.profile.identity, worktreeRoot: dir, checkout: dir } },
    evaluate: ({ pr: n }) => (n === 42 ? red : evaluation(n)),
    resolveCause: () => ({ ok: true, job: "CI Gate", step: "Test", cause: [{ where: "src/x.ts:1", message: "boom" }] }),
    containment: { credentialRead: "closed", why: "test" }, keychain: { measured: true, items: [], why: null },
    claudeBin: "/bin/sh", cliVersion: "test",
    oauthToken: () => ({ ok: true, token: "sk-ant-oat01-test-token-not-a-real-credential", why: null }),
    prepareCheckout: () => ({ ok: true, path: dir, why: null, deps: { ok: true, cow: false } }),
    spawnWorker: async (args) => { spawned.push(args); return { outcome: "ok", why: "done", ms: 1, cost: 0, sessionId: "s1" }; },
    capacity: () => { halt(); return { allowed: 5, running: 0, canStart: 5, load1: 0, perfCores: 10 }; } });
  assert.ok(existsSync(ctx.haltMarker), "control: the tick reached the step before a worker would start");
  assert.equal(spawned.length, 0, "a worker started after HALT");
  assert.ok(withdrawn.some((w) => w.head === headOf(43) && /halted/.test(w.why)), JSON.stringify(withdrawn));
});

test("an alert that a PASS couldn't be withdrawn clears once a later withdrawal takes it back", async () => {
  const { ctx } = setup();
  await daemon.tick(ctx);
  const fail = { ...ctx, withdraw: async () => ({ ok: false, why: "HTTP 502" }), notify: () => ({ ok: true }) };
  daemon.tellStuck(fail, await daemon.withdrawStanding(fail, "the merge policy stopped"));
  const standing = () => ctx.db.prepare("SELECT why FROM escalation").all().map((r) => r.why).filter((w) => /may no longer hold/.test(w));
  assert.equal(standing().length, 2, "control: the failed withdrawals are on record");
  // systemd's reeve withdraw, straight after, succeeds.
  daemon.tellStuck(ctx, await daemon.withdrawStanding(ctx, "the merge policy stopped"));
  assert.deepEqual(standing(), [], "the alert still says the PASS couldn't be withdrawn");
  assert.match(readFileSync(ctx.logPath, "utf8"), /CLEARED: #7: /);
});

test("no alert is cleared when what stands couldn't be read: nothing is known to have been withdrawn", async () => {
  const { ctx } = setup();
  await daemon.tick(ctx);
  const fail = { ...ctx, withdraw: async () => ({ ok: false, why: "HTTP 502" }), notify: () => ({ ok: true }) };
  daemon.tellStuck(fail, await daemon.withdrawStanding(fail, "the merge policy stopped"));
  const standing = () => ctx.db.prepare("SELECT why FROM escalation").all().map((r) => r.why).filter((w) => /may no longer hold/.test(w));
  assert.equal(standing().length, 2, "control: the failed withdrawals are on record");
  const blind = await daemon.withdrawStanding({ ...ctx, db: unreadable(ctx.db) }, "the merge policy stopped");
  daemon.tellStuck({ ...ctx, notify: () => ({ ok: true }) }, blind);
  assert.equal(standing().length, 2, "an alert was cleared though nothing could be read");
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
// A PASS on #7 in the scratch home's store.
const standPass = (home) => {
  const store = open(statePathFor(home, NWO));
  store.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(Math.floor(Date.now() / 1000), "daemon", "pr.published", "pr:7", JSON.stringify({ head: headOf(7), state: "PASS", name: "ops/merge-policy", id: 55 }));
  store.close?.();
};
const scratchHome = ({ standing = true } = {}) => {
  const home = tempDir("reeve-withdraw-home-");
  const db = statePathFor(home, NWO);
  mkdirSync(dirname(db), { recursive: true });
  open(db).close?.();
  if (standing) standPass(home);
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

// Both run the real CLI as above. The scratch profile has no notify channel, so
// what a person would be pushed is read from the log's NEEDS YOU line.
test("a stopped daemon that couldn't withdraw a PASS tells a person, not only its log", async () => {
  // The PASS is written after the halted tick, which would have told of it
  // itself, so what's told is the stop's.
  const home = scratchHome({ standing: false });
  writeFileSync(join(home, "HALT"), "");
  const child = spawn(process.execPath, [join(ROOT, "bin", "reeve"), "run", NWO, "--interval", "600"],
    { cwd: home, env: { ...process.env, REEVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  try {
    const exited = new Promise((r) => child.on("exit", (code) => r(code)));
    for (let n = 0; n < 300 && !/halted — sleeping/.test(out); n++) await new Promise((r) => setTimeout(r, 100));
    standPass(home);
    child.kill("SIGTERM");
    assert.equal(await exited, 0, out.slice(-600));
    const stopping = out.slice(out.indexOf("SIGTERM"));
    assert.match(stopping, /NEEDS YOU: #7: [^\n]*PASS[^\n]*couldn't withdraw/, stopping.slice(0, 900));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

test("reeve withdraw tells a person about a PASS it couldn't withdraw, not only its exit code", () => {
  const home = scratchHome();
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), "withdraw", NWO],
    { cwd: home, env: { ...process.env, REEVE_HOME: home }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  let log = "";
  try { log = readFileSync(join(home, "reeve.log"), "utf8"); } catch { /* none written */ }
  assert.match(`${r.stdout}${r.stderr}${log}`, /NEEDS YOU: #7: [^\n]*PASS[^\n]*couldn't withdraw/, `${r.stdout}${r.stderr}${log}`);
});

test("reeve withdraw clears the alert a stop raised once nothing is left standing", () => {
  const home = scratchHome();
  const store = open(statePathFor(home, NWO));
  const at = Math.floor(Date.now() / 1000);
  // The stop couldn't withdraw #7's PASS and said so; since then it was withdrawn.
  store.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)")
    .run(at, "daemon", "pr.withdrawn", "pr:7", JSON.stringify({ head: headOf(7), name: "ops/merge-policy", id: 55, why: "the merge policy stopped" }));
  const stuck = "#7: a PASS reeve published may no longer hold, and reeve couldn't withdraw it";
  store.prepare("INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count) VALUES(?,?,?,?,?)").run(stuck, 1, at, at, 1);
  store.close?.();
  const r = spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), "withdraw", NWO],
    { cwd: home, env: { ...process.env, REEVE_HOME: home }, encoding: "utf8", timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const after = open(statePathFor(home, NWO));
  assert.deepEqual(after.prepare("SELECT why FROM escalation").all().map((x) => x.why), [], "the alert still stands");
  after.close?.();
});

test("a one-shot tick refuses --enforce: once it exits, nothing re-checks its PASS or takes it back", () => {
  const home = scratchHome();
  writeFileSync(join(home, "HALT"), "");   // a tick that runs returns at once
  const reeve = (...args) => spawnSync(process.execPath, [join(ROOT, "bin", "reeve"), ...args],
    { cwd: home, env: { ...process.env, REEVE_HOME: home }, encoding: "utf8", timeout: 60_000 });
  for (const args of [["tick", NWO, "--enforce"], ["run", NWO, "--tick", "--enforce"]]) {
    const r = reeve(...args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--enforce/, r.stderr);
  }
  // In shadow a one-shot tick still runs: halted, it exits 3.
  const shadow = reeve("tick", NWO);
  assert.equal(shadow.status, 3, `${shadow.stdout}${shadow.stderr}`);
});
