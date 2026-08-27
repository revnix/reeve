// R-04 must tell a FAILING base from one that never ran.
//
// A workflow whose runner never starts reports `conclusion: failure` with zero
// executed steps, and from the run list alone that is byte-identical to a genuine
// test failure. The two are opposite problems with nothing in common as remedies:
// one is a bug to fix, the other is infrastructure to restore, and reporting the
// second as a failing base sends somebody to read a diff that is fine.
//
// This is not hypothetical here. On 2026-08-26 every run in this repository
// reported failure with zero steps for about twenty-two hours, because the
// organisation's Actions minutes were exhausted. R-04 read the conclusions and
// reported "1 of the last 7 runs failed", treating six runs that never executed
// as passing and one as a real failure. Every number in that sentence was wrong.
import { checkBaseHealth } from "../src/doctor.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "o/r";
// The run list, as `gh run list --json conclusion,databaseId` renders it.
const list = rows => ({ sh: () => ({ ok: true, out: rows.map(([c, id]) => `${c}\t${id}`).join("\n") }) });
const stepsBy = map => (_nwo, id) => (id in map ? map[id] : true);

// The measured shape: every run reports failure, none executed a step.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"], ["failure", "2"], ["failure", "3"]]),
    steps: stepsBy({ "1": false, "2": false, "3": false }),
  });
  check(r.level === "BROKEN", "a base where nothing executed is BROKEN", r.level);
  check(/never ran/.test(r.lines.join(" ")), "and says so in those words", JSON.stringify(r.lines));
  check(/not executing/.test(r.lines.join(" ")),
    "naming the infrastructure rather than the code", JSON.stringify(r.lines));
  check(!/inherits a red rollup/.test(r.lines.join(" ")),
    "and NOT as a red base, which would send someone to read a diff that is fine");
  check(/0 of the last 3/.test(r.lines[0]),
    "the failure count is zero, because none of them failed — they did not run",
    r.lines[0]);
}

// The opposite: real failures, steps executed. The original behaviour, preserved.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"], ["failure", "2"]]),
    steps: stepsBy({ "1": true, "2": true }),
  });
  check(r.level === "BROKEN", "control: a genuinely red base is still BROKEN", r.level);
  check(/inherits a red rollup/.test(r.lines.join(" ")),
    "control: and still says the thing that is true of a red base", JSON.stringify(r.lines));
}

// A healthy base spends no extra request at all: `steps` is asked only of runs
// that report failure, so a green base cannot cost ten API calls.
{
  let asked = 0;
  const r = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["success", "1"], ["success", "2"]]),
    steps: () => { asked++; return true; },
  });
  check(r.level === "OK", "a green base is OK", r.level);
  check(asked === 0, "and costs no jobs request, because only failures are asked about", String(asked));
}

// Mixed, which is the case that decides whether the split is real: one genuine
// failure beside one that never ran must report BOTH, not one number covering both.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"], ["failure", "2"], ["success", "3"]]),
    steps: stepsBy({ "1": true, "2": false }),
  });
  check(r.level === "DEGRADED", "a mix is DEGRADED rather than either extreme", r.level);
  check(/1 of the last 3/.test(r.lines[0]), "one real failure is counted as one", r.lines[0]);
  check(/1 run\(s\) reported failure without executing/.test(r.lines.join(" ")),
    "and the one that never ran is counted separately", JSON.stringify(r.lines));
}

// A jobs read that fails is UNKNOWN — neither failed nor never-ran. Guessing
// either way is exactly how the original defect happened.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"]]),
    steps: () => null,
  });
  check(r.level === "UNKNOWN", "an unreadable run is UNKNOWN, not assumed either way", r.level);
  check(/could not be read/.test(r.lines.join(" ")), "and says which way it is unknown",
    JSON.stringify(r.lines));
}

// Control: the whole read failing is still UNKNOWN, unchanged.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", { sh: () => ({ ok: false, out: "" }) });
  check(r.level === "UNKNOWN", "control: an unreadable run list is UNKNOWN as before", r.level);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
