// Shadow mode must never satisfy a required check (#160).
//
// In shadow mode reeve published `neutral` as ops/merge-policy, and GitHub counts
// `neutral` as passing a required check. With the check required, or made
// required after a shadow result was published, a pull request passed the gate
// unjudged. Shadow results now publish under their own name, which no rule
// requiring the real check can accept. These tests drive publishVerdict against a
// fake GitHub that records what would be published, and requiredOn against the
// shapes GitHub's rules and branch protection take.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishVerdict, requiredOn, requiredOnBase, shadowContextOf } from "../src/pr.mjs";
import { tick } from "../src/daemon.mjs";
import { open } from "../src/db/ops.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r", CONTEXT = "ops/merge-policy", APP = "12345";
const verdict = { state: "BLOCK", summary: "ci: failing", head: "a".repeat(40), clauses: [] };
const rule = (context, integration_id) => JSON.stringify({ type: "required_status_checks", parameters: { required_status_checks: [{ context, integration_id }] } });
const RULES_NONE = { ok: true, out: JSON.stringify({ type: "deletion" }) };
const rulesRequiring = (context, integration_id = null) => ({ ok: true, out: [JSON.stringify({ type: "deletion" }), rule(context, integration_id)].join("\n") });
const NOT_PROTECTED = { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } }) };
const FORBIDDEN = { ok: false, err: "gh: Resource not accessible by integration (HTTP 403)" };

// A fake GitHub: the runs already at the head, the base's rules and protection,
// and every write, in order.
const github = ({ runs = [], rules = RULES_NONE, branch = NOT_PROTECTED, refuse = () => false } = {}) => {
  const writes = [], reads = [];
  const api = (_token, args) => {
    const path = args.find((a) => typeof a === "string" && a.startsWith("repos/"));
    const verb = args.includes("PATCH") ? "PATCH" : args.includes("POST") ? "POST" : "GET";
    if (verb === "GET") {
      reads.push({ path, paginate: args.includes("--paginate") });
      if (path.includes("/check-runs?")) return runs.ok === false ? runs : { ok: true, out: runs.map((r) => JSON.stringify(r)).join("\n") };
      if (path.includes("/rules/branches/")) return rules;
      if (/\/branches\/[^/]+$/.test(path)) return branch;
      return { ok: false, err: `unexpected read ${path}` };
    }
    const field = (k) => (args.find((a) => typeof a === "string" && a.startsWith(`${k}=`)) ?? "").slice(k.length + 1);
    writes.push({ verb, path, name: field("name"), conclusion: field("conclusion"), title: field("output[title]") });
    // `refuse` names the writes that fail, the way GitHub refuses one.
    if (refuse(verb, path)) return { ok: false, err: "gh: Resource not accessible by integration (HTTP 403)" };
    return { ok: true, out: JSON.stringify({ id: 99 }) };
  };
  return { api, writes, reads, auth: async () => ({ ok: true, token: "t", appId: APP }) };
};
let n = 0;   // a fresh base per case, so the minute-long cache can't carry one case's answer into the next
const publish = (gh, over = {}) => publishVerdict({ nwo: NWO, verdict, shadow: true, context: CONTEXT, base: `main-${++n}`, auth: gh.auth, api: gh.api, ...over });

// ── what shadow mode publishes ────────────────────────────────────────────────
{
  const gh = github();
  const r = await publish(gh);
  const post = gh.writes.find((w) => w.verb === "POST");
  check(post?.name === shadowContextOf(CONTEXT) && post.name !== CONTEXT && post.conclusion === "neutral" && !r.held,
    "shadow mode publishes under its own name, never the enforcement check's, so no rule requiring that check can accept it", JSON.stringify(gh.writes));
}
{
  const gh = github({ runs: [{ name: CONTEXT, id: 5, conclusion: "neutral", app: "merge-policy" }] });
  const r = await publish(gh);
  const patch = gh.writes.find((w) => w.verb === "PATCH" && w.path.endsWith("/check-runs/5"));
  check(patch?.conclusion === "cancelled" && /Superseded/.test(patch.title) && r.superseded,
    "a passing result an earlier version published under the enforcement name at this head is marked superseded", JSON.stringify(gh.writes));
}
{
  // A passing result left under the enforcement name passes that check for as
  // long as it stands, so a publication that can't supersede it, or can't look
  // for it, has failed.
  const stuck = github({ runs: [{ name: CONTEXT, id: 5, conclusion: "neutral", app: "merge-policy" }], refuse: (verb, path) => verb === "PATCH" && path.endsWith("/check-runs/5") });
  const r = await publish(stuck);
  check(r.ok === false && /couldn't be superseded/.test(r.why ?? "") && /403/.test(r.why ?? "") && !r.superseded,
    "a passing result under the enforcement name that can't be superseded fails the publication, and says why", JSON.stringify(r));
  const blind = github({ runs: { ok: false, err: "gh: HTTP 502" } });
  const b = await publish(blind);
  check(b.ok === false && /couldn't be read/.test(b.why ?? "") && blind.writes.some((w) => w.verb === "POST" && w.name === shadowContextOf(CONTEXT)),
    "and so does one that can't read the runs to look for it, though its own result is still published", JSON.stringify({ b, writes: blind.writes }));
  const exposed = github({ runs: [{ name: CONTEXT, id: 5, conclusion: "neutral", app: "merge-policy" }], rules: rulesRequiring(CONTEXT, APP),
    refuse: (verb, path) => verb === "PATCH" && path.endsWith("/check-runs/5") });
  const x = await publish(exposed);
  check(/can pass that check unjudged/.test(x.held ?? ""),
    "with a rule requiring the check, a passing result that can't be superseded is held as a pull request that can merge unjudged", JSON.stringify(x));
  const control = await publish(github({ runs: [{ name: CONTEXT, id: 5, conclusion: "neutral", app: "merge-policy" }] }));
  check(control.ok === true && control.superseded === true, "control: one that is superseded publishes cleanly", JSON.stringify(control));
}
{
  const other = github({ runs: [{ name: CONTEXT, id: 6, conclusion: "neutral", app: "someone-else" }] });
  await publish(other);
  const failing = github({ runs: [{ name: CONTEXT, id: 7, conclusion: "failure", app: "merge-policy" }] });
  await publish(failing);
  check(!other.writes.some((w) => w.path.endsWith("/check-runs/6")) && !failing.writes.some((w) => w.path.endsWith("/check-runs/7")),
    "control: another App's run is left alone, and so is one of reeve's that doesn't pass");
}
{
  const gh = github({ rules: rulesRequiring(CONTEXT, APP) });
  const r = await publish(gh);
  check(/every pull request there is blocked/.test(r.held ?? "") && gh.writes.find((w) => w.verb === "POST")?.conclusion === "neutral",
    "with the enforcement check required on the base, shadow mode says every pull request there is blocked", JSON.stringify(r));
}
{
  const gh = github({ rules: FORBIDDEN, branch: FORBIDDEN });
  const r = await publishVerdict({ nwo: NWO, verdict, shadow: false, context: CONTEXT, base: "main-enforce", auth: gh.auth, api: gh.api });
  const post = gh.writes.find((w) => w.verb === "POST");
  check(post?.name === CONTEXT && post.conclusion === "failure" && !r.held && !gh.reads.some((x) => x.path.includes("/rules/")),
    "control: enforcing, the real conclusion is published under the policy's name, and no rule is read", JSON.stringify(gh.writes));
}

// ── whether the enforcement check is required, and whose it is ───────────────
check(requiredOn({ rules: rulesRequiring(CONTEXT, APP), branch: NOT_PROTECTED }, CONTEXT, { appId: APP }) === true
  && requiredOn({ rules: rulesRequiring(CONTEXT, null), branch: NOT_PROTECTED }, CONTEXT, { appId: APP }) === true,
  "a rule requiring the check from reeve's App, or from any App, requires reeve's check");
check(requiredOn({ rules: rulesRequiring(CONTEXT, "999"), branch: NOT_PROTECTED }, CONTEXT, { appId: APP }) === false,
  "a rule requiring the check from another App doesn't require reeve's: GitHub waits for that App");
check(requiredOn({ rules: rulesRequiring(CONTEXT, "999"), branch: NOT_PROTECTED }, CONTEXT, { appId: null }) === null,
  "with reeve's own App id unknown, a check bound to some App is unknown, never a guess");
check(requiredOn({ rules: RULES_NONE, branch: { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: true,
  required_status_checks: { contexts: [CONTEXT], checks: [{ context: CONTEXT, app_id: Number(APP) }] } } }) } }, CONTEXT, { appId: APP }) === true,
  "classic branch protection requiring it from reeve's App requires it");
check(requiredOn({ rules: RULES_NONE, branch: NOT_PROTECTED }, CONTEXT, { appId: APP }) === false
  && requiredOn({ rules: rulesRequiring("some/other-check"), branch: NOT_PROTECTED }, CONTEXT, { appId: APP }) === false,
  "control: required nowhere, or only another check required, is not required");
check(requiredOn({ rules: FORBIDDEN, branch: NOT_PROTECTED }, CONTEXT, { appId: APP }) === null
  && requiredOn({ rules: RULES_NONE, branch: FORBIDDEN }, CONTEXT, { appId: APP }) === null
  && requiredOn({ rules: { ok: true, out: "not json" }, branch: NOT_PROTECTED }, CONTEXT, { appId: APP }) === null,
  "rules or protection that couldn't be read are unknown, never taken for not required");
{
  const gh = github({ rules: rulesRequiring(CONTEXT, APP) });
  const ask = (now) => requiredOnBase({ nwo: NWO, base: "cached", context: CONTEXT, gh: (args) => gh.api("t", args), appId: APP, now });
  const first = ask(1_000), second = ask(30_000), later = ask(120_000);
  const ruleReads = gh.reads.filter((x) => x.path.includes("/rules/"));
  check(first === true && second === true && later === true && ruleReads.length === 2 && ruleReads.every((x) => x.paginate),
    "a base's rules are read with every page, once a minute however many pull requests target it", JSON.stringify(gh.reads));
}

// ── what the daemon does with it ──────────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-shadow-required-"));
  try {
    const calls = [];
    const evaluation = (pr) => ({ ok: true, pr, state: "open", head: "b".repeat(40), title: "t", headRef: `f${pr}`, baseRef: "main",
      updatedAt: "2026-09-25T10:00:00Z", verdict: { state: "PASS", summary: "ok", clauses: [] },
      rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 }, checks: { verdict: "GREEN", caused: [], failing: [] },
      reviewers: [], threads: { readable: true, total: 0, unresolved: 0, seen: 0 }, settled: { settled: true } });
    const held = `a rule requires ${CONTEXT} on main, and reeve publishes it only when enforcing, so every pull request there is blocked until it enforces or the rule stops requiring it`;
    const ctx = {
      nwo: NWO, profile: { identity: { key: NWO, defaultBranch: "main" }, authority: { policy: "propose_only" },
        ci: { provider: "github-actions", requiredChecks: [] }, watch: { maxWorkers: 1 }, reviewers: [] },
      db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"), execute: false, shadow: true, running: 0,
      openPrs: () => [7, 8], evaluate: ({ pr }) => evaluation(pr),
      publish: async (args) => { calls.push(args); return { ok: true, id: 1, conclusion: "neutral", held }; },
      observe: () => ({ observations: [], incomplete: false, threads: { readable: true, total: 0, unresolved: 0, seen: 0 } }),
      derivePr: () => ({}), reviewState: () => ({ readable: true, total: 0, open: 0, resolved: 0, unspilledCritical: 0, rounds: 1 }),
    };
    const t = await tick(ctx);
    const log = readFileSync(ctx.logPath, "utf8");
    check(calls.length === 2 && calls.every((c) => c.base === "main"), "the daemon tells the publisher which branch the pull request targets", JSON.stringify(calls.map((c) => c.base)));
    const raised = [...(t.escalations?.entries?.() ?? [])].filter(([cause]) => /shadow mode/.test(cause));
    check(/every pull request there is blocked/.test(log) && raised.length === 1,
      "and a blocked gate shadow mode found is logged and raised once for the person, not once per pull request",
      JSON.stringify({ raised, log: log.split("\n").filter((l) => /shadow/.test(l)).slice(0, 3) }));

    // A publication that failed can still carry what it held, and that is when it
    // matters most: a passing result it couldn't supersede lets the pull request
    // merge unjudged.
    const unjudged = `a rule requires ${CONTEXT} on main, and the passing result an earlier version left under ${CONTEXT} at bbbbbbbb couldn't be superseded (HTTP 403), so pull request head bbbbbbbb can pass that check unjudged`;
    const failed = await tick({ ...ctx, logPath: join(dir, "log2.txt"),
      publish: async () => ({ ok: false, why: "published, but a passing result couldn't be superseded", held: unjudged }) });
    const raisedAfterFailure = [...(failed.escalations?.entries?.() ?? [])].filter(([cause]) => /unjudged/.test(cause));
    check(raisedAfterFailure.length === 1 && /could not publish/.test(readFileSync(join(dir, "log2.txt"), "utf8")),
      "a failed publication still raises what it held, and logs the failure", JSON.stringify(raisedAfterFailure));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
