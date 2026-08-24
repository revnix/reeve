// The commit message reeve writes for a worker's repair.
//
// It is built from model output that has read untrusted CI logs, and it lands in
// the founder's history permanently, so it has to hold under text nobody chose:
// a first word longer than the whole subject, a sentence ending in a full stop,
// control characters, and nothing at all.
import { repairMessage } from "../src/daemon.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const PREFIX = /^fix\((ci|review)\): /;
const subjectOf = m => m.split("\n")[0];

for (const [what, report, action] of [
  ["an ordinary change", { change: "use the UTC accessors", cause: "the day was read in local time" }, "FIX_CI"],
  ["a sentence longer than the subject", { change: "use the UTC accessors so that two readers in different timezones agree on which day it is", cause: "c" }, "FIX_CI"],
  // The case that produced exactly `fix(ci):` -- a valid-looking subject with no
  // description at all, which Conventional Commits does not permit and which a
  // human reading `git log` cannot use.
  ["a first token longer than the room", { change: "x".repeat(100), cause: "c" }, "FIX_CI"],
  ["a change ending in a full stop", { change: "use the UTC accessors.", cause: "c" }, "FIX_CI"],
  ["no change reported", { change: "", cause: "c" }, "FIX_CI"],
  ["no report fields at all", {}, "FIX_CI"],
  ["a review repair", { change: "narrow the access rule", cause: "c" }, "FIX_FINDINGS"],
]) {
  const m = repairMessage(report, { action });
  const s = subjectOf(m);
  check(PREFIX.test(s), `${what}: the subject is Conventional Commits`, s);
  check(s.length <= 72, "and fits 72 characters", `${s.length}: ${s}`);
  check(s.replace(PREFIX, "").length > 0, "and has a description, not just a type", JSON.stringify(s));
  check(!/^[A-Z]/.test(s.replace(PREFIX, "")), "and the description is lowercase", s);
  check(!/\.$/.test(s), "and does not end in a full stop", s);
}

// Untrusted text must not reach a terminal as control characters. The report has
// read CI logs, and a log can carry anything.
{
  const ESC = String.fromCharCode(27), BEL = String.fromCharCode(7);
  const m = repairMessage({ change: `boom${ESC}[31m red`, cause: `and${BEL}bell` }, { action: "FIX_CI" });
  const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`);
  const withoutNewlines = m.replace(/\n/g, "");
  check(!CONTROL.test(withoutNewlines), "control characters are neutralised in both halves", JSON.stringify(m));
}

// The body is the report's `cause`, and absent when there is none.
{
  const withCause = repairMessage({ change: "a", cause: "because b" }, { action: "FIX_CI" });
  check(withCause.split("\n\n")[1] === "because b", "the body is the reported cause", JSON.stringify(withCause));
  const without = repairMessage({ change: "a" }, { action: "FIX_CI" });
  check(!without.includes("\n"), "and there is no body when no cause was reported", JSON.stringify(without));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
