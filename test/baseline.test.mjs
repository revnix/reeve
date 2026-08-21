// S0 freezes authority: the live ruleset and profile facts are captured once,
// checked in, and every later reading is compared against them. A silent
// change to a required check, a bypass actor, or a merge switch is exactly the
// drift that turns a dark capability live without anyone deciding it.
import { diffBaseline, checkBaseline, baselinePathFor } from "../src/baseline.mjs";
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const fixture = JSON.parse(readFileSync(baselinePathFor("nextlyhq/nextly"), "utf8"));

check(Array.isArray(fixture.rulesetRequiredChecks) && typeof fixture.capturedAt === "string",
  "control: the fixture has the captured shape", JSON.stringify(Object.keys(fixture)));

{
  const same = diffBaseline(fixture, fixture);
  check(same.drifted === false && same.lines.length === 0, "identical readings do not drift", JSON.stringify(same));
}
{
  const live = structuredClone(fixture);
  live.rulesetRequiredChecks = [...live.rulesetRequiredChecks, "ops/merge-policy"];
  const d = diffBaseline(live, fixture);
  check(d.drifted === true && /required checks/.test(d.lines.join(" ")),
    "a new required check is drift, and is named", JSON.stringify(d.lines));
}
{
  const live = structuredClone(fixture);
  live.profile.capabilities.mergeBuilderPr = true;
  const d = diffBaseline(live, fixture);
  check(d.drifted === true && /mergeBuilderPr/.test(d.lines.join(" ")),
    "a capability switch turning on is drift, and is named", JSON.stringify(d.lines));
}
{
  const d = diffBaseline(null, fixture);
  check(d.drifted === true && /could not read/.test(d.lines.join(" ")),
    "an unreadable live state is drift, never agreement", JSON.stringify(d));
}


// ── the doctor check, and that doctor actually runs it ───────────────────────
{
  const profile = { authority: { policy: fixture.profile.authorityPolicy }, merge: { enforcement: fixture.profile.mergeEnforcement },
                    builder: { capabilities: fixture.profile.capabilities } };
  const same = checkBaseline("nextlyhq/nextly", profile, { readLive: () => fixture });
  check(same.id === "R-13" && same.level === "OK", "a live reading that matches is OK", JSON.stringify(same));

  const drifted = structuredClone(fixture); drifted.rulesetBypassActors = [];
  const d = checkBaseline("nextlyhq/nextly", profile, { readLive: () => drifted });
  check(d.level === "DEGRADED" && /bypass actors/.test(d.lines.join(" ")), "drift is DEGRADED and named", JSON.stringify(d.lines));

  const u = checkBaseline("nextlyhq/nextly", profile, { readLive: () => { throw new Error("HTTP 401"); } });
  check(u.level === "UNKNOWN" && /could not read/.test(u.lines.join(" ")), "an unreadable live state is UNKNOWN, never OK", JSON.stringify(u));

  const none = checkBaseline("o/never-captured", profile, { readLive: () => fixture });
  check(none.level === "UNKNOWN" && /no baseline captured/.test(none.lines.join(" ")), "a repo with no baseline is UNKNOWN, with the command to fix it", JSON.stringify(none));

  // Shipped is not mounted: doctor's own check list must name it.
  const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
  const list = src.slice(src.indexOf("const checks = ["), src.indexOf("].filter(Boolean)"));
  check(/checkBaseline\(nwo, profile, baselineIo\)/.test(list), "control: runDoctor's check list includes the baseline check", list.slice(-120));
}


// ── every applicable ruleset counts, and a new ruleset is drift ──────────────
{
  const { readLiveBaseline } = await import("../src/baseline.mjs");
  const gh = path => {
    if (path.endsWith("/rulesets")) return [{ id: 1, name: "weak", enforcement: "active" }, { id: 2, name: "strong", enforcement: "active" }, { id: 3, name: "off", enforcement: "disabled" }];
    if (path.endsWith("/rulesets/1")) return { rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1, require_code_owner_review: false } }], bypass_actors: [] };
    if (path.endsWith("/rulesets/2")) return { rules: [{ type: "pull_request", parameters: { required_approving_review_count: 2, require_code_owner_review: true } }], bypass_actors: [] };
    if (/protection$/.test(path)) { const e = new Error("gh: Not Found (HTTP 404)"); e.stderr = "gh: Not Found (HTTP 404)"; throw e; }
    throw new Error("unexpected " + path);
  };
  const live = readLiveBaseline("o/r", { authority: { policy: "p" }, merge: { enforcement: "e" }, builder: { capabilities: {} } }, { gh });
  check(live.requiredApprovals === 2 && live.codeOwnerReview === true,
    "the strictest pull-request rule across active rulesets is the effective one", JSON.stringify([live.requiredApprovals, live.codeOwnerReview]));
  check(JSON.stringify(live.rulesetNames) === JSON.stringify(["weak", "strong"]), "disabled rulesets are not counted", JSON.stringify(live.rulesetNames));
  const renamed = structuredClone(fixture); renamed.rulesetNames = [...renamed.rulesetNames, "extra"];
  check(diffBaseline(renamed, fixture).drifted === true && /ruleset/.test(diffBaseline(renamed, fixture).lines.join(" ")), "a ruleset appearing is drift even when its rules match", "");
}


// ── the branch comes from the profile; a baseline names the branch it read ───
{
  const { readLiveBaseline } = await import("../src/baseline.mjs");
  const asked = [];
  const gh = path => { asked.push(path); if (path.endsWith("/rulesets")) return []; const e = new Error("HTTP 404"); e.stderr = "HTTP 404"; throw e; };
  readLiveBaseline("o/r", { identity: { baseBranch: "develop", defaultBranch: "main" }, authority: {}, merge: {}, builder: {} }, { gh });
  check(asked.some(p => /branches\/develop\/protection/.test(p)), "the live read targets the profile's base branch, not main", asked.join(" | "));
  const live = readLiveBaseline("o/r", { identity: { defaultBranch: "trunk" }, authority: {}, merge: {}, builder: {} }, { gh });
  check(live.branch === "trunk", "and records which branch it read", JSON.stringify(live.branch));
}

// ── a malformed baseline is UNKNOWN, never a crash ───────────────────────────
{
  const { writeFileSync: wf, mkdtempSync: md } = await import("node:fs");
  const { tmpdir: td } = await import("node:os");
  const { join: jn } = await import("node:path");
  const bad = jn(md(jn(td(), "reeve-badbase-")), "x.json"); wf(bad, "{ not json");
  let r = null, threw = null;
  try { r = checkBaseline("o/r", {}, { fixturePath: bad, readLive: () => fixture }); } catch (e) { threw = e; }
  check(!threw && r?.level === "UNKNOWN" && /baseline/.test(r.lines.join(" ")), "a malformed baseline reports UNKNOWN with the file error", threw ? String(threw.message) : JSON.stringify(r));
}

// ── only rulesets that target the branch count ───────────────────────────────
{
  const { readLiveBaseline } = await import("../src/baseline.mjs");
  const gh = path => {
    if (path.endsWith("/rulesets")) return [{ id: 1, name: "main-only", enforcement: "active" }, { id: 2, name: "release-only", enforcement: "active" }, { id: 3, name: "everything", enforcement: "active" }];
    if (path.endsWith("/rulesets/1")) return { conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 1 } }], bypass_actors: [] };
    if (path.endsWith("/rulesets/2")) return { conditions: { ref_name: { include: ["refs/heads/release/*"], exclude: [] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 5 } }], bypass_actors: [{ actor_type: "Team", actor_id: 9, bypass_mode: "always" }] };
    if (path.endsWith("/rulesets/3")) return { conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/main"] } }, rules: [{ type: "pull_request", parameters: { required_approving_review_count: 7 } }], bypass_actors: [] };
    const e = new Error("HTTP 404"); e.stderr = "HTTP 404"; throw e;
  };
  const live = readLiveBaseline("o/r", { identity: { defaultBranch: "main" }, authority: {}, merge: {}, builder: {} }, { gh });
  check(live.requiredApprovals === 1 && live.rulesetBypassActors.length === 0 && JSON.stringify(live.rulesetNames) === JSON.stringify(["main-only"]),
    "a ruleset scoped to another branch, or excluding this one, is not counted", JSON.stringify([live.requiredApprovals, live.rulesetNames, live.rulesetBypassActors]));
}

// ── classic branch protection's review requirements count too ────────────────
{
  const { readLiveBaseline } = await import("../src/baseline.mjs");
  const gh = path => {
    if (path.endsWith("/rulesets")) return [];
    if (/protection$/.test(path)) return { required_status_checks: { checks: [] }, required_pull_request_reviews: { required_approving_review_count: 2, require_code_owner_reviews: true } };
    throw new Error("unexpected " + path);
  };
  const live = readLiveBaseline("o/r", { identity: { defaultBranch: "main" }, authority: {}, merge: {}, builder: {} }, { gh });
  check(live.requiredApprovals === 2 && live.codeOwnerReview === true, "approvals and code-owner review enforced by classic protection are part of the effective value", JSON.stringify([live.requiredApprovals, live.codeOwnerReview]));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
