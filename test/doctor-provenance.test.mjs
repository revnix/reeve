// R-17, as a table: what code would the daemon actually run?
//
// The rule exists because "stale by accident" and "pinned on purpose" were
// indistinguishable from outside. Establishing that the launchd job was running a
// commit 43 merges old took reading the plist, grepping the daemon for update
// logic that does not exist, and comparing two checkouts by hand -- and nothing
// reported it, because nothing was asking.
//
// A TABLE, because every failure here is "this state reached the wrong level",
// and the levels carry real consequences: BROKEN means the guardian is enforcing
// rules from code no review saw, and OK on that state would be the worst possible
// answer.
import { checkDaemonProvenance, programArguments, checkoutFromArgs } from "../src/doctor.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const PLIST = (args) => `<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>${(args ?? []).map(a => `<string>${a}</string>`).join("")}</array>
</dict></plist>`;
const GOOD_ARGS = ["/n/bin/node", "/Users/x/deploy/bin/reeve", "run", "o/r"];

// `run` dispatched on the git subcommand, so each row states only what it changes.
const runner = (over = {}) => (cwd, args) => {
  const key = args[0] === "rev-list" ? (args[2].includes("..HEAD") ? "ahead" : "behind") : args[0];
  const d = { "rev-parse": { ok: true, out: "abcdef1234567890" },
              status: { ok: true, out: "" },
              ahead: { ok: true, out: "0" },
              behind: { ok: true, out: "0" } };
  return over[key] ?? d[key] ?? { ok: false, out: "", err: "unexpected " + args.join(" ") };
};

const TABLE = [
  { name: "no launchd job installed is UNKNOWN, never OK",
    io: { plist: () => null }, level: "UNKNOWN",
    why: "`nothing is installed` and `the job is fine` must not be the same answer" },
  { name: "a job declaring no ProgramArguments is UNKNOWN",
    io: { plist: () => "<plist><dict></dict></plist>" }, level: "UNKNOWN" },
  { name: "a job that runs something other than bin/reeve is UNKNOWN",
    io: { plist: () => PLIST(["/usr/bin/true"]) }, level: "UNKNOWN",
    why: "the daemon is started some other way; this rule cannot say from where" },
  { name: "a path that is not a git checkout is BROKEN",
    io: { plist: () => PLIST(GOOD_ARGS), run: runner({ "rev-parse": { ok: false, out: "", err: "not a git repository" } }) },
    level: "BROKEN", why: "the guardian would enforce rules from code with no commit behind it" },
  { name: "an uncommitted change in the deploy tree is BROKEN",
    io: { plist: () => PLIST(GOOD_ARGS), run: runner({ status: { ok: true, out: " M src/daemon.mjs" } }) },
    level: "BROKEN", why: "what runs is not any commit, so nobody can say what it is" },
  { name: "a commit the default branch has never seen is BROKEN",
    io: { plist: () => PLIST(GOOD_ARGS), run: runner({ ahead: { ok: true, out: "2" } }) },
    level: "BROKEN", why: "code no review looked at, enforcing rules on everyone else" },
  // THE ROW THE TWO-COUNT SHAPE EXISTS FOR. `merge-base --is-ancestor` answers
  // FALSE and FAILS with the same non-zero exit, so a git that could not run
  // would be reported as unreviewed code -- an infrastructure failure wearing the
  // most alarming verdict this rule has.
  { name: "a comparison that could not RUN is UNKNOWN, not unreviewed code",
    io: { plist: () => PLIST(GOOD_ARGS), run: runner({ ahead: { ok: false, out: "", err: "unknown revision" } }) },
    level: "UNKNOWN", why: "a failed probe must not be readable as the thing it failed to measure" },
  { name: "the deploy tree at the default branch is OK",
    io: { plist: () => PLIST(GOOD_ARGS), run: runner() }, level: "OK" },
  { name: "behind the default branch is still OK, because pinning is legitimate",
    io: { plist: () => PLIST(GOOD_ARGS), run: runner({ behind: { ok: true, out: "43" } }) },
    level: "OK", why: "a guardian held at a promoted commit is working as designed" },
];

for (const { name, io, level, why } of TABLE) {
  const r = checkDaemonProvenance({ run: runner(), plist: () => PLIST(GOOD_ARGS), ...io });
  check(r.level === level, name, `${r.level} (wanted ${level})${why ? " -- " + why : ""}\n        ${(r.lines ?? []).join("\n        ")}`);
  check(r.id === "R-17", `control: ${name} is reported under R-17`, r.id);
}

// ── the rule does not claim what it has not measured ──────────────────────────
{
  const r = checkDaemonProvenance({ run: runner({ behind: { ok: true, out: "43" } }), plist: () => PLIST(GOOD_ARGS) });
  const text = r.lines.join(" ");
  check(/43 commit\(s\) behind/.test(text), "it states the distance as a number", text);
  // The first draft said "pinned, not drifting" for a checkout nobody had pinned.
  // Nothing on the machine records a promotion, so the reassuring reading is the
  // one this rule must not take.
  check(!/pinned, not drifting/.test(text),
    "and does NOT assert the distance was deliberate, which nothing here records", text);
  check(/nothing here RECORDS a promotion/i.test(text),
    "it says outright that a deliberate pin and an unpulled checkout read identically", text);
}

// ── the two readers, alone ────────────────────────────────────────────────────
{
  check(programArguments(PLIST(["a", "b"]))?.join(",") === "a,b", "ProgramArguments reads every string in order");
  check(programArguments("<plist></plist>") === null, "and answers null when there is no array to read");
  check(checkoutFromArgs(GOOD_ARGS) === "/Users/x/deploy", "the checkout is the parent of the bin/ that holds reeve");
  check(checkoutFromArgs(["/usr/bin/reeved"]) === null,
    "control: a path merely CONTAINING reeve is not bin/reeve", String(checkoutFromArgs(["/usr/bin/reeved"])));
  check(checkoutFromArgs([]) === null, "control: no arguments names no checkout");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
