// R-17, as a table: what code is the daemon actually running?
//
// The rule exists because "stale by accident" and "pinned on purpose" were
// indistinguishable from outside. Establishing that the launchd job ran a commit
// 43 merges old took reading the plist, grepping the daemon for update logic that
// does not exist, and comparing two checkouts by hand -- and nothing reported it,
// because nothing was asking.
//
// THREE FACTS THAT DISAGREE, and the first version conflated them: what launchd
// has LOADED, what the installed plist DECLARES for the next load, and what the
// running PROCESS read at startup. A table, because every failure here is "this
// state reached the wrong level", and the levels carry consequences: BROKEN means
// the guardian enforces rules from code no review saw.
import { checkDaemonProvenance, programArguments, checkoutFromArgs,
         loadedArguments, decodeXml } from "../src/doctor.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const PLIST = (args) => `<plist version="1.0"><dict>
  <key>ProgramArguments</key>
  <array>${(args ?? []).map(a => `<string>${a}</string>`).join("")}</array>
</dict></plist>`;
const ARGS = ["/n/bin/node", "/Users/x/deploy/bin/reeve", "run", "o/r"];
const SHA = "abcdef1234567890";

const runner = (over = {}) => (cwd, args) => {
  const key = args[0] === "rev-list" ? (args[2].includes("..HEAD") ? "ahead" : "behind")
            : args[0] === "rev-parse" && args[1]?.startsWith("origin/") ? "localref"
            : args[0];
  const d = { "rev-parse": { ok: true, out: SHA },
              localref: { ok: true, out: "deadbeef" },
              "ls-remote": { ok: true, out: "deadbeef\trefs/heads/main" },
              status: { ok: true, out: "" },
              ahead: { ok: true, out: "0" },
              behind: { ok: true, out: "0" } };
  return over[key] ?? d[key] ?? { ok: false, out: "", err: "unexpected " + args.join(" ") };
};
const base = { run: runner(), plist: () => PLIST(ARGS), runningCommit: () => SHA };
const at = (io) => checkDaemonProvenance({ ...base, ...io });

const TABLE = [
  { name: "no job installed and none loaded is UNKNOWN, never OK",
    io: { plist: () => null, launchctl: () => null }, level: "UNKNOWN",
    why: "`nothing is installed` and `the job is fine` must not be the same answer" },
  { name: "a job declaring no ProgramArguments is UNKNOWN",
    io: { plist: () => "<plist><dict></dict></plist>" }, level: "UNKNOWN" },
  { name: "a job that runs something other than bin/reeve is UNKNOWN",
    io: { plist: () => PLIST(["/usr/bin/true"]) }, level: "UNKNOWN" },
  { name: "a path that is not a git checkout is BROKEN",
    io: { run: runner({ "rev-parse": { ok: false, out: "", err: "not a git repository" } }) },
    level: "BROKEN" },
  { name: "an uncommitted change in the deploy tree is BROKEN",
    io: { run: runner({ status: { ok: true, out: " M src/daemon.mjs" } }) }, level: "BROKEN" },
  // A FAILED STATUS PROBE IS NOT A CLEAN TREE. rev-parse and rev-list can succeed
  // with an unreadable index, so falling through would return OK having never
  // established whether the executable tree is the commit it just named.
  { name: "a status probe that FAILED is UNKNOWN, not a clean tree",
    io: { run: runner({ status: { ok: false, out: "", err: "index is corrupt" } }) }, level: "UNKNOWN" },
  { name: "a commit the default branch has never seen is BROKEN",
    io: { run: runner({ ahead: { ok: true, out: "2" } }) }, level: "BROKEN" },
  // THE TRACKING REF MAY PREDATE THE MERGE. Comparing against a local ref that
  // has not fetched since the commit landed reports reviewed code as unreviewed,
  // which is this rule's most alarming verdict on a healthy deployment.
  { name: "a STALE tracking ref is UNKNOWN rather than unreviewed code",
    io: { run: runner({ localref: { ok: true, out: "0000old" },
                        "ls-remote": { ok: true, out: "deadbeef\trefs/heads/main" },
                        ahead: { ok: true, out: "2" } }) }, level: "UNKNOWN" },
  { name: "a comparison that could not RUN is UNKNOWN, not unreviewed code",
    io: { run: runner({ ahead: { ok: false, out: "", err: "unknown revision" } }) }, level: "UNKNOWN",
    why: "`merge-base --is-ancestor` answers false and fails with the same exit; this counts twice instead" },
  // WHAT THE LIVE PROCESS LOADED IS NOT HEAD. A running Node process holds the
  // modules it read at startup, so a checkout pulled afterwards reports a clean
  // current commit while the daemon executes an older one.
  { name: "a running process on a DIFFERENT commit than HEAD is DEGRADED",
    io: { runningCommit: () => "0ldc0de" }, level: "DEGRADED",
    why: "a clean checkout would otherwise certify the provenance of a tree the daemon is not running" },
  { name: "the deploy tree at the default branch is OK", io: {}, level: "OK" },
  { name: "behind the default branch is still OK, because pinning is legitimate",
    io: { run: runner({ behind: { ok: true, out: "43" } }) }, level: "OK" },
];

for (const { name, io, level, why } of TABLE) {
  const r = at(io);
  check(r.level === level, name, `${r.level} (wanted ${level})${why ? " -- " + why : ""}\n        ${(r.lines ?? []).join("\n        ")}`);
  check(r.id === "R-17", `control: ${name} is reported under R-17`, r.id);
}

// ── the LOADED job outranks the installed file ───────────────────────────────
{
  // launchd caches its configuration at bootstrap, so an edited plist does not
  // reach a running job. The file says what the NEXT load will use; only
  // launchctl says what is executing.
  const r = at({ plist: () => PLIST(["/n/bin/node", "/edited/path/bin/reeve"]),
                 launchctl: () => "arguments = {\n\t/n/bin/node\n\t/Users/x/deploy/bin/reeve\n}\n" });
  const text = r.lines.join(" ");
  check(/\/Users\/x\/deploy/.test(text), "the LOADED arguments decide which checkout is measured", text);
  check(/has not been reloaded/.test(text),
    "and a plist that disagrees with the loaded job is itself reported", text);
}

// ── the rule does not claim what it has not measured ─────────────────────────
{
  const text = at({ run: runner({ behind: { ok: true, out: "43" } }) }).lines.join(" ");
  check(/43 commit\(s\) behind/.test(text), "it states the distance as a number", text);
  check(!/pinned, not drifting/.test(text),
    "and does NOT assert the distance was deliberate, which nothing here records", text);
  // The first version called every readable HEAD a "promoted commit", including
  // a checkout merely behind because nobody pulled -- asserting the reassuring
  // intent the rule itself says it cannot establish.
  check(!/promoted commit/.test(text),
    "nor calls an unrecorded HEAD a promoted one", text);
  check(/nothing here RECORDS a deployment/i.test(text),
    "it says outright that a deliberate pin and an unpulled checkout read identically", text);
}

// ── the readers, alone ───────────────────────────────────────────────────────
{
  check(programArguments(PLIST(["a", "b"]))?.join(",") === "a,b", "ProgramArguments reads every string in order");
  check(programArguments("<plist></plist>") === null, "and answers null when there is no array to read");
  // A valid plist escapes `&`, so a path like `/Users/A & B/...` is stored
  // encoded. Running git in a literal `&amp;` directory reports BROKEN for a
  // healthy checkout.
  check(decodeXml("/Users/A &amp; B") === "/Users/A & B", "a plist string is XML-decoded before it is used as a path");
  check(programArguments(PLIST(["/Users/A &amp; B/bin/reeve"]))[0] === "/Users/A & B/bin/reeve",
    "and the decoding happens where the arguments are read");
  check(checkoutFromArgs(ARGS, { realpath: (p) => p }) === "/Users/x/deploy",
    "the checkout is the parent of the bin/ that holds reeve");
  // launchd may invoke a symlink whose target lives in the checkout; stripping
  // the textual path would name /usr/local and report BROKEN for a clean tree.
  check(checkoutFromArgs(["/usr/local/bin/reeve"], { realpath: () => "/checkout/bin/reeve" }) === "/checkout",
    "a SYMLINKED entry point resolves to the checkout that holds the code");
  check(checkoutFromArgs(["/usr/bin/reeved"], { realpath: (p) => p }) === null,
    "control: a path merely CONTAINING reeve is not bin/reeve");
  check(checkoutFromArgs([], { realpath: (p) => p }) === null, "control: no arguments names no checkout");
  check(loadedArguments("arguments = {\n\t/a\n\t/b\n}\n")?.join(",") === "/a,/b",
    "launchctl's loaded arguments are read in order");
  check(loadedArguments("no arguments block") === null, "and answer null when launchctl reports none");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
