// The reconciler's classification and settlement rules. Every case is a shape
// measured on a real PR, and each one is a way a naive implementation reports
// green on something that is not.
import { classify, settle } from "../src/github/reconciler.mjs";

let fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { console.log(`        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); fail++; }
};

const run = (name, conclusion = null) => ({ name, source: "check_run", state: conclusion ? "completed" : "running", conclusion });
const status = (name, state, description = "") => ({ name, source: "status", state: state === "pending" ? "running" : "completed", conclusion: state === "pending" ? null : state, description });

// ── classify ──────────────────────────────────────────────────────────────

// Absence is the failure mode that produced 116 unreviewed merges. An empty set
// is not green; a fork PR shows zero check-runs while being unmergeable.
check("no checks at all is UNKNOWN, never GREEN", classify([]).verdict, "UNKNOWN");

check("all passing is GREEN", classify([run("a", "success"), run("b", "skipped"), run("c", "neutral")]).verdict, "GREEN");
check("one failure is RED", classify([run("a", "success"), run("b", "failure")]).verdict, "RED");
check("anything in flight is RUNNING", classify([run("a", "success"), run("b", null)]).verdict, "RUNNING");

// These two are outside the REST-documented set and fall straight through a
// naive `conclusion === "failure"` branch into a silent pass.
check("startup_failure blocks", classify([run("a", "success"), run("b", "startup_failure")]).verdict, "RED");
check("timed_out is a real failure, not a cancellation", classify([run("a", "timed_out")]).verdict, "RED");

// A cancelled run is a SUPERSEDED run, not a failing one. It still refuses a
// merge, because UNKNOWN never merges, but it must not escalate to a human the
// way a real failure does. Measured: this produced a false "base is red" push
// on the first shadow tick.
check("cancelled is uninformative, not RED", classify([run("a", "cancelled")]).verdict, "UNKNOWN");
check("stale is uninformative, not RED", classify([run("a", "stale")]).verdict, "UNKNOWN");
check("but a real failure alongside a cancellation is still RED",
  classify([run("a", "cancelled"), run("b", "failure")]).verdict, "RED");
check("and a cancellation never reads as GREEN",
  classify([run("a", "success"), run("b", "cancelled")]).verdict, "UNKNOWN");
check("timed_out blocks", classify([run("a", "timed_out")]).verdict, "RED");
check("action_required blocks", classify([run("a", "action_required")]).verdict, "RED");

// An unrecognised value must block, not be ignored: the enum grows.
check("an unknown conclusion blocks", classify([run("a", "some_new_state_github_added")]).verdict, "RED");

// A required check that never reported can never report. Waiting forever and
// merging are both wrong; it is its own verdict.
check("a required check that never reported is MISSING_REQUIRED",
  classify([run("a", "success")], ["CI Gate"]).verdict, "MISSING_REQUIRED");
check("a required check that DID report is not missing",
  classify([run("CI Gate", "success")], ["CI Gate"]).verdict, "GREEN");

// Commit statuses and check runs disagree; both must count. Measured at PR
// #1119's head: combined status success while a check run was failure.
check("a failing check run beats a passing status",
  classify([status("CodeRabbit", "success"), run("Browser tests", "failure")]).verdict, "RED");
check("a pending status is in flight, not passing",
  classify([run("a", "success"), status("ctx", "pending")]).verdict, "RUNNING");

// ── settle ────────────────────────────────────────────────────────────────

const green = sha => ({ verdict: "GREEN", sha, rows: [run("a", "success"), run("b", "success")] });

{
  // One green reading is not settlement: a workflow that has not scheduled its
  // jobs yet reports an empty, unfailing set indistinguishable from a clean run.
  let s = null;
  s = settle(s, green("aaa")); check("green poll 1 is not settled", s.settled, false);
  s = settle(s, green("aaa")); check("green poll 2 is not settled", s.settled, false);
  s = settle(s, green("aaa")); check("green poll 3 settles", s.settled, true);
  check("and the verdict is GREEN", s.verdict, "GREEN");
}
{
  // A push resets the streak: the old readings describe a revision nobody is merging.
  let s = null;
  s = settle(s, green("aaa")); s = settle(s, green("aaa"));
  s = settle(s, green("bbb"));
  check("a new sha resets the streak", s.streak, 1);
  check("and is not settled", s.settled, false);
}
{
  // The floor rule: fewer checks than were seen before means jobs have gone
  // missing, not that the run is clean.
  let s = null;
  for (let i = 0; i < 3; i++) s = settle(s, { verdict: "GREEN", sha: "aaa", rows: [run("a", "success"), run("b", "success"), run("c", "success")] });
  check("three checks settle", s.settled, true);
  const shrunk = settle(s, { verdict: "GREEN", sha: "ccc", rows: [run("a", "success")] });
  check("a shrunken check set does not settle", shrunk.settled, false);
  check("and reports UNKNOWN rather than GREEN", shrunk.verdict, "UNKNOWN");
}
{
  // Red settles immediately: there is nothing to wait for.
  const s = settle(null, { verdict: "RED", sha: "aaa", rows: [run("a", "failure")] });
  check("red settles on the first reading", s.settled, true);
}
{
  // A changed check-NAME set at the same sha means the workflow is still
  // scheduling, even though the count may match.
  let s = null;
  s = settle(s, { verdict: "GREEN", sha: "aaa", rows: [run("a", "success"), run("b", "success")] });
  s = settle(s, { verdict: "GREEN", sha: "aaa", rows: [run("a", "success"), run("z", "success")] });
  check("a changed name set resets the streak", s.streak, 1);
}


// A commit-status description may contain a newline. Parsing these surfaces as
// TSV split such a description into a phantom row whose name was a fragment and
// whose conclusion was undefined — which then classified as a failure and
// reported "failing: undefined" to the fixer.
check("a nameless row never counts as failing",
  classify([{ name: "", source: "status", state: "completed", conclusion: undefined },
            run("a", "success")]).failing.length, 0);
// It must not vanish either: an unparseable row means this revision is not
// checkable, and not-checkable never merges.
check("but it makes the revision UNKNOWN rather than GREEN",
  classify([{ name: "", source: "status", state: "completed", conclusion: undefined },
            run("a", "success")]).verdict, "UNKNOWN");
check("and the parse defect is counted, not swallowed",
  classify([{ name: "", state: "completed", conclusion: undefined }, run("a", "success")]).malformed, 1);
check("a clean set reports zero malformed rows", classify([run("a", "success")]).malformed, 0);
check("a genuinely unknown conclusion on a NAMED row still blocks",
  classify([{ name: "real", source: "status", state: "completed", conclusion: "weird" }]).verdict, "RED");


// settle must carry the reading's reason. Dropping it made checks.why undefined,
// which the verdict's MISSING_REQUIRED branch passed through as a clause detail,
// which every consumer then rendered as the literal string "undefined". That was
// the cause behind three separate symptoms.
{
  const red = settle(null, { verdict: "RED", sha: "aaa", rows: [run("a", "failure")], why: "1 check(s) not passing" });
  check("a RED settle carries its reason", red.why, "1 check(s) not passing");
  const missing = settle(null, { verdict: "MISSING_REQUIRED", sha: "aaa", rows: [run("a", "success")], why: "required check(s) never reported: CI Gate" });
  check("a MISSING_REQUIRED settle carries its reason", missing.why, "required check(s) never reported: CI Gate");
  const running = settle(null, { verdict: "RUNNING", sha: "aaa", rows: [run("a", null)], why: "1 check(s) still in flight" });
  check("a RUNNING settle carries its reason", running.why, "1 check(s) still in flight");
  // The whole point: no settle result may render as "undefined".
  for (const [name, r] of [["RED", red], ["MISSING_REQUIRED", missing], ["RUNNING", running]])
    check(`a ${name} reason is never the string 'undefined'`, String(r.why) === "undefined", false);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
