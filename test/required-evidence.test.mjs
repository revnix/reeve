// One cancelled ancillary job made an entire branch permanently uncheckable, and
// through it every open pull request.
//
// Measured live on nextlyhq/nextly main at 6c9a5ab0: both profile-required checks
// were green, and a single non-required job -- "Dev script starts every watcher
// (windows-latest)" -- was `cancelled`. classify() reported the whole revision
// UNKNOWN, so `base verdict UNKNOWN` blocked all five open PRs for hours.
//
// Fail-closed is right, but it has to be closed around something. A cancelled run
// is a SUPERSEDED run, and an obsolete job nobody requires cannot be allowed to
// veto forever. The required set is what decides which absences matter.
import { classify } from "../src/github/reconciler.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const row = (name, conclusion) => ({ name, conclusion, state: "completed", source: "check_run" });
const REQUIRED = ["Lint / Typecheck / Test / Build", "Browser tests"];
const greenRequired = REQUIRED.map(n => row(n, "success"));

// The live shape, exactly.
{
  const rows = [...greenRequired, row("Dev script starts every watcher (windows-latest)", "cancelled")];
  const c = classify(rows, REQUIRED);
  check(c.verdict === "GREEN",
    "a cancelled ANCILLARY check does not veto when every required check is green", JSON.stringify(c));
  check((c.uninformative ?? []).length === 1 || (c.ancillaryUninformative ?? []).length === 1,
    "but it is still reported, not silently dropped", JSON.stringify(c));
}

// The half that must not weaken.
{
  const rows = [row(REQUIRED[0], "cancelled"), row(REQUIRED[1], "success")];
  const c = classify(rows, REQUIRED);
  check(c.verdict === "UNKNOWN",
    "a cancelled REQUIRED check is still UNKNOWN — that absence is the one that matters",
    JSON.stringify(c));
}

// With no required set declared, reeve has no basis to call anything ancillary,
// so it must keep refusing. Fail closed where the profile is silent.
{
  const rows = [row("something", "success"), row("other", "cancelled")];
  const c = classify(rows, []);
  check(c.verdict === "UNKNOWN",
    "with NO required set declared, any cancellation is still UNKNOWN", JSON.stringify(c));
}

// A genuinely failing ancillary check is different from a cancelled one: it is
// evidence, not the absence of it, and a red main is still a red main.
{
  const rows = [...greenRequired, row("Dev script starts every watcher (windows-latest)", "failure")];
  const c = classify(rows, REQUIRED);
  check(c.verdict === "RED",
    "a FAILING ancillary check still blocks — cancelled is an absence, failed is a fact",
    JSON.stringify(c));
}

// And the controls that must not move.
{
  check(classify(greenRequired, REQUIRED).verdict === "GREEN", "control: all green is GREEN");
  check(classify([row(REQUIRED[0], "success")], REQUIRED).verdict === "MISSING_REQUIRED",
    "control: an absent required check is still MISSING_REQUIRED");
  check(classify([], REQUIRED).verdict === "UNKNOWN", "control: no checks at all is UNKNOWN");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
