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
import { checkBaseHealth, runExecutedSteps } from "../src/doctor.mjs";

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
  check(/executed no steps/.test(r.lines.join(" ")),
    "and reports what was measured: no step executed", JSON.stringify(r.lines));
  check(/nothing on this branch has been measured/.test(r.lines.join(" ")),
    "and says what follows from it — no downstream gate means anything", JSON.stringify(r.lines));
  // A zero step count says no step RAN. It does not say why, and the two causes
  // want opposite responses: an exhausted runner quota is infrastructure and the
  // code is blameless, while a workflow whose expressions cannot be evaluated is
  // the repository's own bug and reads identically from here.
  check(/cause is NOT determined here/.test(r.lines.join(" ")),
    "and refuses to name a cause it cannot see", JSON.stringify(r.lines));
  check(!/infrastructure is not|CI is not executing/.test(r.lines.join(" ")),
    "control: it does NOT blame infrastructure, which would send an operator to billing for a broken workflow file");
  check(!/inherits a red rollup/.test(r.lines.join(" ")),
    "and NOT as a red base, which would send someone to read a diff that is fine");
  check(/3 of the last 3 completed/.test(r.lines[0]),
    "the run list's own fact leads: three concluded failure", r.lines[0]);
  check(/3 of those executed no steps/.test(r.lines.join(" ")),
    "and the step read explains them rather than deciding them", JSON.stringify(r.lines));
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
  check(/2 of the last 3 completed/.test(r.lines[0]),
    "two concluded failure, which is what the run list says", r.lines[0]);
  check(/1 of those executed no steps/.test(r.lines.join(" ")),
    "and one of those executed nothing, which is what the step read adds", JSON.stringify(r.lines));
}

// A jobs read that fails is UNKNOWN — neither failed nor never-ran. Guessing
// either way is exactly how the original defect happened.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"]]),
    steps: () => null,
  });
  // The run LIST already says nothing succeeded. Being unable to read WHY does not
  // soften that: the unreadable run concluded failure either way.
  check(r.level === "BROKEN",
    "an all-failure history is broken even when the reason cannot be read", r.level);
  check(/could not be read, so why they failed is unknown/.test(r.lines.join(" ")),
    "and says the reason is unknown without letting that change the verdict",
    JSON.stringify(r.lines));
}

// Control: the whole read failing is still UNKNOWN, unchanged.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", { sh: () => ({ ok: false, out: "" }) });
  check(r.level === "UNKNOWN", "control: an unreadable run list is UNKNOWN as before", r.level);
}

// ── an unreadable step read does not subtract from an all-red history ───────
//
// The run list and the step reads answer different questions. The list says
// whether anything succeeded — that alone decides whether the base is usable. The
// step reads only explain why, and they can fail without changing the first
// answer. Folding them into the verdict meant one transient jobs-endpoint error
// turned nine executed failures plus one unreadable into DEGRADED, when all ten
// concluded failure and nothing succeeded.
{
  const r = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"], ["failure", "2"], ["failure", "3"]]),
    steps: (_n, id) => (id === "3" ? null : true),
  });
  check(r.level === "BROKEN",
    "two executed failures and one unreadable is still an all-red base", r.level);
  check(/3 of the last 3 completed/.test(r.lines[0]),
    "because the run list says three of three concluded failure", r.lines[0]);
  check(/1 of those could not be read/.test(r.lines.join(" ")),
    "and the unreadable one is reported rather than silently dropped", JSON.stringify(r.lines));
}

// ── a base with NO usable result is broken however it got there ─────────────
//
// Splitting "failed" from "executed nothing" made each test homogeneous, so a
// sample of five real failures and five that never ran — ten of ten with no usable
// measurement in it — fell through both and reported DEGRADED. The implementation
// this replaced called the same all-failure history BROKEN, so classifying the
// causes more precisely made the base look HEALTHIER: a refinement that lost the
// coarser truth it refined.
{
  const mixed = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"], ["failure", "2"], ["failure", "3"], ["failure", "4"]]),
    steps: stepsBy({ "1": true, "2": true, "3": false, "4": false }),
  });
  check(mixed.level === "BROKEN",
    "two real failures and two that never ran is BROKEN, not degraded", mixed.level);
  check(/no completed run in this sample produced a usable result/.test(mixed.lines.join(" ")),
    "and says the thing that is true of BOTH causes rather than picking one",
    JSON.stringify(mixed.lines));
  check(!/every PR inherits|nothing on this branch has been measured/.test(mixed.lines.join(" ")),
    "control: without claiming either homogeneous story, neither of which is true here");

  // Control: one usable result is the difference between broken and degraded, so
  // the union is not simply making everything broken.
  const oneGood = checkBaseHealth(NWO, "ci.yml", "main", {
    ...list([["failure", "1"], ["failure", "2"], ["success", "3"]]),
    steps: stepsBy({ "1": true, "2": false }),
  });
  check(oneGood.level === "DEGRADED",
    "control: a single usable run is still the line between degraded and broken", oneGood.level);
}

// ── the denominator counts only runs that have ANSWERED ─────────────────────
//
// `gh run list` returns queued and in-progress runs with an empty conclusion, and
// they were still counting toward the total. Nine completed failures beside one
// running job read as "9 of the last 10" and DEGRADED, when every completed run
// was red and the honest answer is BROKEN. A denominator quietly including rows
// that cannot answer the question.
{
  const withRows = rows => ({
    sh: (_c, args) => ({ ok: true, out: rows.map(([c, id]) => `${c}\t${id}`).join("\n"),
                         // captured so the request itself can be asserted
                         _args: args }),
    steps: () => true,
  });
  // Two completed failures and one run still going.
  const r = checkBaseHealth(NWO, "ci.yml", "main", withRows([["failure", "1"], ["failure", "2"], ["", "3"]]));
  check(/2 of the last 2 completed/.test(r.lines[0]),
    "a run that has not concluded is not in the denominator", r.lines[0]);
  check(r.level === "BROKEN",
    "so a base whose every COMPLETED run is red reads as broken, not degraded", r.level);

  // And the request asks for completed runs in the first place, so the parser is
  // a second line of defence rather than the only one.
  let seen = null;
  checkBaseHealth(NWO, "ci.yml", "main", {
    sh: (_c, args) => { seen = args; return { ok: true, out: "success\t1" }; },
    steps: () => true,
  });
  check(seen.includes("--status") && seen[seen.indexOf("--status") + 1] === "completed",
    "and the run list is asked for completed runs, not filtered only after the fact",
    JSON.stringify(seen));
}

// ── the jobs read must cover EVERY page ─────────────────────────────────────
//
// The workflow-jobs endpoint defaults to 30 per page and a matrix run exceeds
// that easily. `--jq` is applied PER PAGE, so an aggregate yields one number per
// page rather than one overall — measured, not assumed: with per_page=1 against a
// two-job run gh prints "9" then "3".
//
// Without summing, a run whose first thirty jobs executed nothing but whose
// thirty-first did would be reported as unmeasured: a check answering from part
// of its input and reporting the part as the whole, which is the exact defect the
// surrounding function exists to correct.
{
  const pages = out => ({ sh: () => ({ ok: true, out }) });
  check(runExecutedSteps("o/r", "1", pages("9\n3")) === true,
    "pages are summed, not read one at a time");
  check(runExecutedSteps("o/r", "1", pages("0\n0\n0")) === false,
    "every page empty is the only way to conclude nothing ran");
  // THE CASE CODEX NAMED: nothing on the first page, steps on a later one.
  check(runExecutedSteps("o/r", "1", pages("0\n5")) === true,
    "a later page carrying the only steps is still steps");
  check(runExecutedSteps("o/r", "1", pages("0")) === false,
    "control: a single empty page is still nothing ran");
  check(runExecutedSteps("o/r", "1", { sh: () => ({ ok: false, out: "" }) }) === null,
    "a failed read is UNKNOWN, not an answer");
  check(runExecutedSteps("o/r", "1", pages("not-a-number")) === null,
    "control: an unparseable page is UNKNOWN rather than counted as zero");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
