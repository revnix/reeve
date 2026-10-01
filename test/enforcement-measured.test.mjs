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
import { readState, render as renderStatus } from "../src/status.mjs";
import { renderHtml } from "../src/dash.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { OFFLINE_READS, offlineEnv } from "./fixtures/offline-github.mjs";
import { statePathFor } from "../src/paths.mjs";
import { withDefaults } from "../src/profile/schema.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
import { POLICY_CONTEXT } from "../src/github/reconciler.mjs";

const NWO = "o/r", APP = "12345";
const verdict = { state: "BLOCK", summary: "ci: failing", head: "a".repeat(40), clauses: [] };
const rule = (/** @type {string} */ context, /** @type {number | null} */ integration_id) =>
  JSON.stringify({ type: "required_status_checks", parameters: { required_status_checks: [{ context, integration_id }] } });
const RULES_NONE = { ok: true, out: JSON.stringify({ type: "deletion" }) };
const rulesRequiring = (/** @type {string} */ context, /** @type {number | null} */ integration_id = null) =>
  ({ ok: true, out: [JSON.stringify({ type: "deletion" }), rule(context, integration_id)].join("\n") });
const NOT_PROTECTED = { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } }) };
const FORBIDDEN = { ok: false, err: "gh: Resource not accessible by integration (HTTP 403)" };

/** A fake GitHub, as test/shadow-required-check.test.mjs has it: the base's rules and protection, and every write, its body too. */
function github({ rules = RULES_NONE, branch = NOT_PROTECTED } = {}) {
  /** @type {{ verb: string, path: string, name: string, conclusion: string, title: string, summary: string }[]} */ const writes = [];
  const api = (/** @type {string} */ _token, /** @type {string[]} */ args) => {
    const path = String(args.find((a) => typeof a === "string" && a.startsWith("repos/")));
    const verb = args.includes("PATCH") ? "PATCH" : args.includes("POST") ? "POST" : "GET";
    if (verb === "GET") {
      if (path.includes("/check-runs?")) return { ok: true, out: "" };
      if (path.includes("/status?")) return { ok: true, out: "" };
      if (path.includes("/rules/branches/")) return rules;
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
  const of = (/** @type {any} */ rules, branch = NOT_PROTECTED) =>
    pr.enforcementOf(pr.requirementsOn({ rules, branch }, POLICY_CONTEXT, { appId: APP }), { base: "main" });
  /** @type {any} */ let got;
  try {
    got = {
      pinned: of(rulesRequiring(POLICY_CONTEXT, Number(APP))),
      none: of(RULES_NONE),
      another: of(rulesRequiring(POLICY_CONTEXT, 999)),
      unbound: of(rulesRequiring(POLICY_CONTEXT, null)),
      unread: of(FORBIDDEN, FORBIDDEN),
      // Its rules read, the branch's not: whether another requirement takes any App's result can't be told.
      partial: of(rulesRequiring(POLICY_CONTEXT, Number(APP)), FORBIDDEN),
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
  assert.equal(got.unnamed.state, "unknown", "nor one bound to an App reeve can't name");
});

test("each result reeve publishes says whether its base enforces it, and why, enforcing or in shadow", async () => {
  const pinned = github({ rules: rulesRequiring(POLICY_CONTEXT, Number(APP)) });
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
      pinned: await pr.enforcementNow({ nwo: NWO, base: "enf-1", auth: gh(rulesRequiring(POLICY_CONTEXT, Number(APP))).auth, api: gh(rulesRequiring(POLICY_CONTEXT, Number(APP))).api }),
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
