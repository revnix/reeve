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

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
