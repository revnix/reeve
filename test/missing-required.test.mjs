// "A required check never reported" is an ABSENCE, and absence needs a reason to
// be believed. Counting observations is not one.
//
// Measured on the live shadow record: nextlyhq/nextly #1127 escalated
// "a required check never reported" on four consecutive ticks at a FIXED head
// (16:54:55, 16:57:51, 17:00:47, 17:03:39), then reported the checks RUNNING at
// 17:06:34 and cleared at 17:07:42. The checks had simply not been scheduled yet;
// they arrived 698 seconds after the first reading. A three-observation rule
// settles at 352 seconds, so it would still have paged a human 347 seconds early.
// The first version of this fix did exactly that.
//
// What DOES terminate: the CI provider's own check-suites. Measured at that head,
// all 13 github-actions suites reached `completed`, while the coderabbitai,
// greptile-apps and vercel suites sat at `queued` with zero runs indefinitely --
// so "wait for every suite" never terminates and "wait for the CI provider's
// suites" does.
import { settle } from "../src/github/reconciler.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const run = (name, conclusion) => ({ name, conclusion, status: "completed" });
const missing = (suitesComplete) => ({
  verdict: "MISSING_REQUIRED", sha: "aaa", rows: [run("lint", "success")],
  why: "required check(s) never reported: CI Gate", suitesComplete,
});

// Three observations while CI is still scheduling must NOT settle, however many
// times reeve looks.
{
  let s = null;
  for (let i = 0; i < 5; i++) s = settle(s, missing(false));
  check(s.settled === false,
    "five observations while the CI provider is still running does not settle", JSON.stringify(s));
  check(s.streak >= 3, "control: the streak really did accumulate, so the count is not what held it back", String(s.streak));
}

// Once the provider is finished and the required check still is not there, the
// absence is real and settling is correct.
{
  let s = null;
  for (let i = 0; i < 3; i++) s = settle(s, missing(false));
  const done = settle(s, missing(true));
  check(done.settled === true && done.verdict === "MISSING_REQUIRED",
    "once the CI provider's suites are complete, a still-absent required check settles", JSON.stringify(done));
  check(done.why === "required check(s) never reported: CI Gate", "and keeps its reason", JSON.stringify(done.why));
}

// Not being able to ask is not an answer.
{
  let s = null;
  for (let i = 0; i < 4; i++) s = settle(s, missing(null));
  check(s.settled === false,
    "an unreadable suite state does not settle — could-not-ask is not confirmation", JSON.stringify(s));
}

// A single look at a finished provider is enough: the evidence is terminal, not
// statistical, so there is nothing to corroborate.
{
  const first = settle(null, missing(true));
  check(first.settled === true,
    "a finished provider settles on the FIRST look, because the evidence is terminal", JSON.stringify(first));
}

// And the asymmetry that motivated all of this must survive: a RED reading is
// present evidence and still settles at once, regardless of suite state.
{
  const red = settle(null, { verdict: "RED", sha: "aaa", rows: [run("a", "failure")], why: "1 failing", suitesComplete: false });
  check(red.settled === true, "a failing check still settles immediately", JSON.stringify(red));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
