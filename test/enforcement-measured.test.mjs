// Enforcement as a measured fact (#166): whether GitHub would hold a merge to the
// result reeve publishes, read from the base's own rules, and said with every
// result, in status and on the dashboard; and --enforce refused where it can't
// hold.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as pr from "../src/pr.mjs";
import * as daemon from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";
import { readState, render as renderStatus, noteEnforcement, ENFORCEMENT_OP } from "../src/status.mjs";
import { renderHtml } from "../src/dash.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { OFFLINE_READS, offlineEnv } from "./fixtures/offline-github.mjs";
import { statePathFor } from "../src/paths.mjs";
import { withDefaults } from "../src/profile/schema.mjs";
import { POLICY_CONTEXT } from "../src/github/reconciler.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");

const NWO = "o/r", APP = "12345";
const verdict = { state: "BLOCK", summary: "ci: failing", head: "a".repeat(40), clauses: [] };
const rule = (/** @type {string} */ context, /** @type {number | null} */ integration_id) =>
  JSON.stringify({ type: "required_status_checks", parameters: { required_status_checks: [{ context, integration_id }] } });
const RULES_NONE = { ok: true, out: JSON.stringify({ type: "deletion" }) };
const rulesRequiring = (/** @type {string} */ context, /** @type {number | null} */ integration_id = null) =>
  ({ ok: true, out: [JSON.stringify({ type: "deletion" }), rule(context, integration_id)].join("\n") });
// The rules as GitHub gives them, each naming the ruleset it comes from.
const rulesFrom = (/** @type {number} */ id, /** @type {string} */ context, /** @type {number | null} */ integration_id) =>
  ({ ok: true, out: [JSON.stringify({ type: "deletion", ruleset_id: id }),
    JSON.stringify({ type: "required_status_checks", ruleset_id: id, parameters: { required_status_checks: [{ context, integration_id }] } })].join("\n") });
// A ruleset read, with who can bypass it; with none of that where `bypass_actors` is left out, as GitHub leaves it for a reader who can't edit the ruleset.
const rulesetWith = (/** @type {any[] | undefined} */ bypass_actors) => (/** @type {number} */ id) =>
  ({ ok: true, out: JSON.stringify({ id, name: `rs-${id}`, enforcement: "active", ...(bypass_actors ? { bypass_actors } : {}) }) });
const ORG_ADMIN = { actor_id: null, actor_type: "OrganizationAdmin", bypass_mode: "pull_request" };
// Classic protection requiring `context`, bound to an App or to none, and the rest of it, administrators held to it or not.
const protectedRequiring = (/** @type {string} */ context, /** @type {number | null} */ app_id) =>
  ({ ok: true, out: JSON.stringify({ protected: true, protection: { enabled: true, required_status_checks: { contexts: [context], checks: [{ context, app_id }] } } }) });
const protectionWith = (/** @type {boolean} */ enforceAdmins) =>
  ({ ok: true, out: JSON.stringify({ enforce_admins: { enabled: enforceAdmins }, required_status_checks: { strict: false } }) });
const NOT_PROTECTED = { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } }) };
const FORBIDDEN = { ok: false, err: "gh: Resource not accessible by integration (HTTP 403)" };
const PINNED = { rules: rulesFrom(7, POLICY_CONTEXT, Number(APP)), ruleset: rulesetWith([]) };

/** A fake GitHub, as test/shadow-required-check.test.mjs has it: the base's rules and protection, and every write, its body too. */
function github({ rules = RULES_NONE, branch = NOT_PROTECTED, protection = /** @type {any} */ (null), ruleset = /** @type {any} */ (null) } = {}) {
  /** @type {{ verb: string, path: string, name: string, conclusion: string, title: string, summary: string }[]} */ const writes = [];
  const api = (/** @type {string} */ _token, /** @type {string[]} */ args) => {
    const path = String(args.find((a) => typeof a === "string" && a.startsWith("repos/")));
    const verb = args.includes("PATCH") ? "PATCH" : args.includes("POST") ? "POST" : "GET";
    if (verb === "GET") {
      if (path.includes("/check-runs?")) return { ok: true, out: "" };
      if (path.includes("/status?")) return { ok: true, out: "" };
      if (path.includes("/rules/branches/")) return rules;
      if (ruleset && /\/rulesets\/\d+$/.test(path)) return ruleset(Number(path.split("/").pop()));
      if (protection && path.endsWith("/protection")) return protection;
      if (/\/branches\/[^/]+$/.test(path)) return branch;
      return { ok: false, err: `unexpected read ${path}` };
    }
    const field = (/** @type {string} */ k) => (args.find((a) => typeof a === "string" && a.startsWith(`${k}=`)) ?? "").slice(k.length + 1);
    writes.push({ verb, path, name: field("name"), conclusion: field("conclusion"), title: field("output[title]"), summary: field("output[summary]") });
    return { ok: true, out: JSON.stringify({ id: 99 }) };
  };
  return { api, writes, auth: async () => ({ ok: true, token: "t", appId: APP }) };
}
let n = 0;   // a fresh base per case, so the minute-long cache can't carry one case's answer into the next
const publish = (/** @type {ReturnType<typeof github>} */ gh, /** @type {any} */ over = {}) =>
  pr.publishVerdict({ nwo: NWO, verdict, shadow: false, base: `main-${++n}`, auth: gh.auth, api: gh.api, ...over });

test("a base enforces reeve's result only where it requires reeve's check from reeve's App; otherwise it's advisory, or unknown where that can't be read", () => {
  const of = (/** @type {any} */ rules, branch = NOT_PROTECTED, ruleset = /** @type {any} */ (null)) =>
    pr.enforcementOf(pr.requirementsOn({ rules, branch, ruleset }, POLICY_CONTEXT, { appId: APP }), { base: "main" });
  /** @type {any} */ let got;
  try {
    got = {
      pinned: of(PINNED.rules, NOT_PROTECTED, PINNED.ruleset),
      none: of(RULES_NONE),
      another: of(rulesRequiring(POLICY_CONTEXT, 999)),
      unbound: of(rulesRequiring(POLICY_CONTEXT, null)),
      unread: of(FORBIDDEN, FORBIDDEN),
      // Its rules read, the branch's not, and who can bypass the rule not either: it can't be told.
      partial: of(rulesRequiring(POLICY_CONTEXT, Number(APP)), FORBIDDEN),
      // Required with no App bound, and the branch unread: its protection could pin it to reeve's App, or not.
      partialUnbound: of(rulesRequiring(POLICY_CONTEXT, null), FORBIDDEN),
      // Bound to an App, and reeve's own App not known: whether it's reeve's can't be told.
      unnamed: pr.enforcementOf(pr.requirementsOn({ rules: rulesRequiring(POLICY_CONTEXT, 999), branch: NOT_PROTECTED }, POLICY_CONTEXT, { appId: null }), { base: "main" }),
    };
  } catch (err) { got = { threw: String(err) }; }
  assert.equal(got.pinned?.state, "enforced", JSON.stringify(got));
  assert.match(got.pinned.why, /main requires merge-policy from reeve's App/);
  assert.equal(got.none.state, "advisory");
  assert.match(got.none.why, /main doesn't require merge-policy from reeve's App/);
  assert.equal(got.another.state, "advisory", "required from another App, reeve's result can't meet it, nor block anything");
  assert.equal(got.unbound.state, "advisory");
  assert.match(got.unbound.why, /requires merge-policy from any App, so another's result under that name could meet it/);
  assert.equal(got.unread.state, "unknown");
  assert.match(got.unread.why, /whether main requires merge-policy from reeve's App can't be read/);
  assert.equal(got.partial.state, "unknown", "a reading that isn't whole can't say it's enforced");
  assert.equal(got.partialUnbound.state, "unknown", "nor that it's advisory");
  assert.equal(got.unnamed.state, "unknown", "nor one bound to an App reeve can't name");
});

test("each result reeve publishes says whether its base enforces it, and why, enforcing or in shadow", async () => {
  const pinned = github(PINNED);
  /** @type {any} */ const enforced = await publish(pinned);
  assert.equal(enforced.ok, true, JSON.stringify(enforced));
  assert.equal(enforced.enforcement?.state, "enforced");
  assert.match(pinned.writes.find((w) => w.verb === "POST")?.summary ?? "", /\*\*Enforced\.\*\* main-\d+ requires merge-policy from reeve's App/);
  const none = github();
  /** @type {any} */ const advisory = await publish(none);
  assert.equal(advisory.enforcement?.state, "advisory");
  assert.match(none.writes.find((w) => w.verb === "POST")?.summary ?? "", /\*\*Advisory\.\*\* main-\d+ doesn't require merge-policy from reeve's App/);
  // In shadow mode, what enforcing would be.
  const shadow = github({ rules: RULES_NONE });
  /** @type {any} */ const r = await publish(shadow, { shadow: true });
  assert.equal(r.enforcement?.state, "advisory");
  assert.match(shadow.writes.find((w) => w.verb === "POST")?.summary ?? "", /Enforcing, it would be \*\*advisory\*\*: main-\d+ doesn't require merge-policy/);
});

/** A tick of o/r with one pull request, #42, blocked on CI and published by `publish`; `shadow` as the daemon runs. */
async function tickWith(/** @type {(a: any) => Promise<any>} */ publish, /** @type {boolean} */ shadow, db = null) {
  const stateDir = tempDir("re-");
  mkdirSync(stateDir, { recursive: true });
  const cl = (/** @type {string} */ id, /** @type {string} */ state, detail = "") => ({ id, state, detail });
  const evaluation = { ok: true, pr: 42, state: "open", head: "a".repeat(40), title: "t", headRef: "f", baseRef: "main",
    verdict: { state: "BLOCK", summary: "ci is red", head: "a".repeat(40),
               clauses: ["ci", "base", "review", "rounds", "threads", "findings", "mergeable"].map((id) => (id === "ci" ? cl("ci", "BLOCK", "failing: CI Gate") : cl(id, "PASS"))) },
    rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
    checks: { verdict: "RED", caused: ["CI Gate"], failing: [{ name: "CI Gate", id: "99" }] },
    reviewers: [], threads: {}, settled: { settled: true } };
  const store = db ?? open(join(stateDir, "e.db"));
  const ctx = {
    ...OFFLINE_READS,
    nwo: "o/r", db: store, logPath: join(stateDir, "reeve.log"), dbPath: join(stateDir, "e.db"),
    profile: { identity: { key: "o/r", defaultBranch: "main" }, authority: { policy: "propose_and_merge" },
               rounds: { softCap: 5, hardCap: 10, maxFixAttemptsPerFinding: 1 }, ci: { provider: "github-actions", requiredChecks: [] },
               watch: { maxWorkers: 5, workerBudgetMinutes: 1, maxTurns: 5 } },
    execute: false, shadow, running: 0,
    openPrs: () => [42], evaluate: () => evaluation, publish,
    observe: () => ({ ok: false, observations: [], incomplete: true, threads: { readable: false, total: null, unresolved: 0, seen: 0 } }),
  };
  await daemon.tick(ctx);
  return { db: store, logged: readFileSync(ctx.logPath, "utf8") };
}
const ADVISORY = { state: "advisory", why: "main doesn't require merge-policy from reeve's App, so what reeve publishes there blocks nothing" };

test("the daemon notes each base's enforcement as it publishes, once while it stands, and status and the dashboard say it", async () => {
  const pub = async () => ({ ok: true, id: 1, conclusion: "neutral", name: "merge-policy (shadow)", enforcement: ADVISORY });
  const first = await tickWith(pub, true);
  await tickWith(pub, true, first.db);
  const noted = first.db.prepare("SELECT COUNT(*) AS n FROM event WHERE op = 'policy.enforcement'").get();
  assert.equal(/** @type {any} */ (noted).n, 1, "noted once while it stands");
  const state = readState(first.db);
  first.db.close();
  assert.deepEqual(state.enforcement?.map((x) => [x.base, x.state, x.why]), [["main", "advisory", ADVISORY.why]]);
  assert.match(renderStatus({ nwo: "o/r", state, health: {} }), /enforcement {2}advisory: main doesn't require merge-policy from reeve's App/);
  assert.match(renderHtml({ nwo: "o/r", state, health: {} }), /enforcement: <b>advisory<\/b>: main doesn&#39;t require merge-policy|enforcement: <b>advisory<\/b>: main doesn't require merge-policy/);
  // Changed, it's noted again.
  const db2 = open(join(tempDir("re2-"), "e.db"));
  await tickWith(pub, true, db2);
  await tickWith(async () => ({ ok: true, id: 1, conclusion: "neutral", name: "merge-policy (shadow)", enforcement: { state: "enforced", why: "main requires merge-policy from reeve's App" } }), true, db2);
  assert.deepEqual(readState(db2).enforcement?.map((x) => x.state), ["enforced"]);
  assert.equal(/** @type {any} */ (db2.prepare("SELECT COUNT(*) AS n FROM event WHERE op = 'policy.enforcement'").get()).n, 2);
  db2.close();
});

test("enforcing, a base that doesn't enforce what reeve publishes is raised every tick", async () => {
  const pub = async () => ({ ok: true, id: 1, conclusion: "failure", name: "merge-policy", enforcement: ADVISORY });
  const enforcing = await tickWith(pub, false);
  enforcing.db.close();
  assert.match(enforcing.logged, /NEEDS YOU: enforcing, but main doesn't require merge-policy from reeve's App/, enforcing.logged.slice(-1500));
  const shadow = await tickWith(pub, true);
  shadow.db.close();
  assert.doesNotMatch(shadow.logged, /enforcing, but/, "control: in shadow mode it's only noted");
});

test("enforcing is measured before the daemon starts, and refused unless the default branch enforces what reeve publishes", async () => {
  const gh = (/** @type {any} */ rules) => github({ rules });
  /** @type {any} */ let got;
  try {
    got = {
      pinned: await pr.enforcementNow({ nwo: NWO, base: "enf-1", auth: github(PINNED).auth, api: github(PINNED).api }),
      none: await pr.enforcementNow({ nwo: NWO, base: "enf-2", auth: gh(RULES_NONE).auth, api: gh(RULES_NONE).api }),
      signedOut: await pr.enforcementNow({ nwo: NWO, base: "enf-3", auth: async () => ({ ok: false, why: "no App credentials" }), api: gh(rulesRequiring(POLICY_CONTEXT, Number(APP))).api }),
    };
  } catch (err) { got = { threw: String(err) }; }
  assert.equal(got.pinned?.state, "enforced", JSON.stringify(got));
  assert.equal(got.none.state, "advisory");
  assert.equal(got.signedOut.state, "unknown");
  assert.match(got.signedOut.why, /reeve's App couldn't be signed in to read enf-3's rules: no App credentials/);
  // reeve run --enforce, on a home whose App can't be signed in to: refused, before anything starts.
  const home = tempDir("reeve-enforce-home-");
  const db = statePathFor(home, "acme/widget");
  mkdirSync(dirname(db), { recursive: true });
  open(db).close();
  mkdirSync(join(home, "profiles", "acme"), { recursive: true });
  writeFileSync(join(home, "profiles", "acme", "widget.json"), JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: "acme/widget", defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] })));
  const r = spawnSync(process.execPath, [REEVE, "run", "acme/widget", "--enforce"], { encoding: "utf8", cwd: home, env: { ...offlineEnv(), REEVE_HOME: home }, timeout: 60_000 });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /reeve run: --enforce refused: reeve's App couldn't be signed in to read main's rules/);
  assert.doesNotMatch(r.stdout + r.stderr, /daemon starting/, "the daemon didn't start");
});

test("a base whose rule requiring reeve's check can be bypassed doesn't enforce it, and one whose bypass can't be read can't say it does", () => {
  const of = (/** @type {any} */ rules, /** @type {any} */ { branch = NOT_PROTECTED, protection = null, ruleset = null } = {}) =>
    pr.enforcementOf(pr.requirementsOn({ rules, branch, protection, ruleset }, POLICY_CONTEXT, { appId: APP }), { base: "main" });
  const PINNED_RULES = rulesFrom(7, POLICY_CONTEXT, Number(APP));
  const CLASSIC = protectedRequiring(POLICY_CONTEXT, Number(APP));
  /** @type {any} */ let got;
  try {
    got = {
      nobody: of(PINNED_RULES, { ruleset: rulesetWith([]) }),
      orgAdmin: of(PINNED_RULES, { ruleset: rulesetWith([ORG_ADMIN]) }),
      // GitHub leaves the bypass list out for a reader who can't edit the ruleset.
      hidden: of(PINNED_RULES, { ruleset: rulesetWith(undefined) }),
      unreadable: of(PINNED_RULES, { ruleset: () => FORBIDDEN }),
      adminsExempt: of(RULES_NONE, { branch: CLASSIC, protection: protectionWith(false) }),
      adminsHeld: of(RULES_NONE, { branch: CLASSIC, protection: protectionWith(true) }),
      protectionUnread: of(RULES_NONE, { branch: CLASSIC, protection: FORBIDDEN }),
      // Bypassable in one place and held in another: GitHub requires both, so it holds.
      heldElsewhere: of(PINNED_RULES, { ruleset: rulesetWith([ORG_ADMIN]), branch: CLASSIC, protection: protectionWith(true) }),
      bothBypassable: of(PINNED_RULES, { ruleset: rulesetWith([ORG_ADMIN]), branch: CLASSIC, protection: protectionWith(false) }),
      // A rule no one can bypass holds, whatever of the rest couldn't be read.
      heldUnwhole: of(PINNED_RULES, { ruleset: rulesetWith([]), branch: FORBIDDEN }),
    };
  } catch (err) { got = { threw: String(err) }; }
  assert.equal(got.orgAdmin?.state, "advisory", "an actor who can bypass the rule can merge without reeve's result: " + JSON.stringify(got));
  assert.equal(got.nobody.state, "enforced");
  assert.match(got.nobody.why, /main requires merge-policy from reeve's App, in ruleset 7, which no one can bypass/);
  assert.match(got.orgAdmin.why, /OrganizationAdmin \(pull_request\) can bypass ruleset 7/);
  assert.equal(got.hidden.state, "unknown");
  assert.match(got.hidden.why, /who can bypass ruleset 7 can't be read/);
  assert.equal(got.unreadable.state, "unknown");
  assert.equal(got.adminsExempt.state, "advisory", "classic protection that exempts administrators doesn't hold them to it");
  assert.match(got.adminsExempt.why, /administrators can bypass branch protection/);
  assert.equal(got.adminsHeld.state, "enforced");
  assert.match(got.adminsHeld.why, /in branch protection, which no one can bypass/);
  assert.equal(got.protectionUnread.state, "unknown");
  assert.equal(got.heldElsewhere.state, "enforced");
  assert.equal(got.bothBypassable.state, "advisory");
  assert.match(got.bothBypassable.why, /OrganizationAdmin \(pull_request\) can bypass ruleset 7, and administrators can bypass branch protection/);
  assert.equal(got.heldUnwhole.state, "enforced");
});

test("a requirement bound to reeve's App holds beside one bound to none, and in shadow the base is blocked, not passable unjudged", async () => {
  const base = { ...PINNED, branch: protectedRequiring(POLICY_CONTEXT, null), protection: protectionWith(true) };
  /** @type {any} */ let read;
  try {
    read = pr.enforcementOf(pr.requirementsOn({ rules: base.rules, branch: base.branch, protection: base.protection, ruleset: base.ruleset }, POLICY_CONTEXT, { appId: APP }), { base: "main" });
  } catch (err) { read = { threw: String(err) }; }
  assert.equal(read.state, "enforced", "another App's result can meet the unbound one, never the one bound to reeve's App: " + JSON.stringify(read));
  const gh = github(base);
  /** @type {any} */ const r = await publish(gh, { shadow: true });
  assert.equal(r.enforcement?.state, "enforced", JSON.stringify(r));
  assert.match(r.held ?? "", /every pull request there is blocked until it enforces/);
  assert.doesNotMatch(r.held ?? "", /with no App bound|unjudged/, "the bound requirement still waits for reeve's App");
});

test("a base's enforcement is noted again once its note is an hour old, and one not measured for two hours shows as stale", () => {
  const ENFORCED = { state: "enforced", why: "main requires merge-policy from reeve's App, in ruleset 7, which no one can bypass" };
  const older = (/** @type {any} */ db, /** @type {number} */ seconds, /** @type {any} */ x) =>
    db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(unixepoch() - ?,?,?,?,?)")
      .run(seconds, "daemon", ENFORCEMENT_OP, "base:main", JSON.stringify({ base: "main", ...x }));
  const count = (/** @type {any} */ db) => /** @type {any} */ (db.prepare("SELECT COUNT(*) AS n FROM event WHERE op = ?").get(ENFORCEMENT_OP)).n;
  // Noted an hour and a minute ago, unchanged since: noted again, so its time says it was measured.
  const db = open(join(tempDir("re-refresh-"), "e.db"));
  older(db, 3660, ENFORCED);
  /** @type {any} */ let again;
  try { again = noteEnforcement(db, "main", ENFORCED); } catch (err) { again = String(err); }
  assert.equal(again, true, "noted again once its note is an hour old");
  assert.equal(count(db), 2);
  assert.equal(noteEnforcement(db, "main", ENFORCED), false, "control: not again within the hour");
  db.close();
  // Last noted three hours ago: the base had no pull request to publish on since, say. Shown as stale, not as standing.
  const stale = open(join(tempDir("re-stale-"), "e.db"));
  older(stale, 3 * 3600, ENFORCED);
  const state = readState(stale);
  stale.close();
  assert.equal(/** @type {any} */ (state.enforcement?.[0])?.stale, true, JSON.stringify(state.enforcement));
  const screen = renderStatus({ nwo: "o/r", state, health: {} });
  assert.match(screen, /enforcement {2}stale: enforced when measured 3h ago, and not measured since: main requires/);
  assert.doesNotMatch(screen, /enforcement {2}enforced:/);
  assert.match(renderHtml({ nwo: "o/r", state, health: {} }), /enforcement: <b>stale<\/b>: enforced when measured 3h ago, and not measured since/);
  // Control: measured within the two hours, it stands.
  const fresh = open(join(tempDir("re-fresh-"), "e.db"));
  older(fresh, 30 * 60, ENFORCED);
  const now = readState(fresh);
  fresh.close();
  assert.equal(/** @type {any} */ (now.enforcement?.[0])?.stale, false);
  assert.match(renderStatus({ nwo: "o/r", state: now, health: {} }), /enforcement {2}enforced: main requires/);
});
