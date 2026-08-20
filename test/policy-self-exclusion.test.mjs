// reeve publishes its verdict as a check run at the head it just judged, and then
// reads every check at that head on the next tick -- including its own. In shadow
// the conclusion is `neutral`, which classifies as passing, so nothing is visibly
// wrong. Under --enforce, BLOCK publishes `failure` and UNKNOWN publishes
// `action_required`; both read back as a red check, so after the first block
// reeve would keep publishing failure even once the original cause had cleared.
// It would latch itself red and never recover.
//
// Measured on nextlyhq/nextly PR #925: 38 `ops/merge-policy` runs exist at that
// head, but the API's default `filter=latest` means reeve reads exactly one of
// them. The latch is one stuck row, not thirty-eight.
//
// The exclusion lives inside readChecks rather than in its callers, so no caller
// can forget it and no future caller has to know.
import { excludeOwnPolicy, POLICY_CONTEXT, POLICY_APP, classify, readChecks } from "../src/github/reconciler.mjs";

let fail = 0, skipped = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const skip = (name, why) => { console.log(`SKIP  ${name}`); console.log("        " + why); skipped++; };

const row = (name, conclusion, app = "github-actions") =>
  ({ name, conclusion, state: "completed", source: "check_run", app });

// Control: an ordinary check must survive, or every exclusion below proves nothing.
{
  const r = excludeOwnPolicy([row("CI Gate", "failure")], POLICY_CONTEXT, POLICY_APP);
  check(r.rows.length === 1 && r.excluded.length === 0,
    "control: an ordinary check is not excluded", JSON.stringify(r));
}

// reeve's own verdict is an OPINION about the evidence, never evidence.
{
  const r = excludeOwnPolicy([row("CI Gate", "success"), row(POLICY_CONTEXT, "failure", POLICY_APP)], POLICY_CONTEXT, POLICY_APP);
  check(r.rows.length === 1 && r.rows[0].name === "CI Gate", "the policy check is excluded by name", JSON.stringify(r));
  check(r.excluded.length === 1, "and it is reported rather than silently dropped", JSON.stringify(r.excluded));
}

// Anything published by reeve's own App is its own opinion too, whatever it is called.
{
  const r = excludeOwnPolicy([row("something-else", "failure", POLICY_APP)], POLICY_CONTEXT, POLICY_APP);
  check(r.rows.length === 0, "any check from reeve's own App is excluded, whatever its name", JSON.stringify(r));
}

// The filter must be exact. Excluding by prefix would blind reeve to real checks.
{
  const r = excludeOwnPolicy([row("ops/merge-policy-extra", "failure"), row("ops/merge", "failure")], POLICY_CONTEXT, POLICY_APP);
  check(r.rows.length === 2, "a similarly-named check from another app is NOT excluded", JSON.stringify(r));
}

// A check carrying reeve's name from someone else's App is not evidence either --
// but it is worth saying out loud, because it means something is impersonating the gate.
{
  const r = excludeOwnPolicy([row(POLICY_CONTEXT, "success", "some-other-app")], POLICY_CONTEXT, POLICY_APP);
  check(r.rows.length === 0, "a foreign check wearing the policy name is still not evidence", JSON.stringify(r));
  check(r.impostors.length === 1, "and it is flagged as an impostor", JSON.stringify(r.impostors));
}

// --- the recovery the audit asks for ----------------------------------------
// Underlying CI goes red then green while the PREVIOUS policy check is still
// `failure`. The next verdict must recover, not latch.
{
  const redRun = classify(excludeOwnPolicy([row("CI Gate", "failure")], POLICY_CONTEXT, POLICY_APP).rows, ["CI Gate"]);
  check(redRun.verdict === "RED", "control: the failing state really is RED first", JSON.stringify(redRun.verdict));

  const afterFix = classify(
    excludeOwnPolicy([row("CI Gate", "success"), row(POLICY_CONTEXT, "failure", POLICY_APP)], POLICY_CONTEXT, POLICY_APP).rows,
    ["CI Gate"]);
  check(afterFix.verdict === "GREEN",
    "CI recovering to green while the prior policy check is still failure yields GREEN",
    JSON.stringify(afterFix));
}

// --- the wiring, against the live API ---------------------------------------
// The pure function being right does not prove readChecks calls it. This is the
// exact gap the audit named, so it is checked against a real head rather than
// asserted. Opt-in because it needs network and gh auth.
if (process.env.REEVE_LIVE === "1") {
  const nwo = process.env.REEVE_LIVE_NWO ?? "nextlyhq/nextly";
  const sha = process.env.REEVE_LIVE_SHA;
  if (!sha) {
    skip("readChecks excludes the policy row at a real head", "set REEVE_LIVE_SHA");
  } else {
    const { ok, rows } = readChecks(nwo, sha);
    check(ok, "control: readChecks reached the API", "no network or no auth");
    check(rows.length > 0, `control: the head has ${rows.length} check(s) after filtering`,
      "an empty set would make the assertion below vacuous");
    const leaked = rows.filter(r => r.name === POLICY_CONTEXT || r.app === POLICY_APP);
    check(leaked.length === 0, "readChecks returns no policy rows at a real head",
      JSON.stringify(leaked));
  }
} else {
  skip("readChecks excludes the policy row at a real head", "set REEVE_LIVE=1 and REEVE_LIVE_SHA to run");
}

if (skipped) console.log(`\n${skipped} assertion(s) skipped — not passed`);
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
