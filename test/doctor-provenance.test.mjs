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
import { checkDaemonProvenance, programArguments, checkoutFromArgs, loadedArguments,
         decodeXml, startupRecordFrom, daemonLogPath, loadedEnvironment } from "../src/doctor.mjs";

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
const LOADED = "arguments = {\n\t/n/bin/node\n\t/Users/x/deploy/bin/reeve\n\trun\n\to/r\n}\n";
const SHA = "abcdef1234567890";
const START = (o = {}) => `reeve daemon starting — node v24.17.0, pid ${o.pid ?? 5}, ` +
  `running commit ${o.commit ?? SHA}${o.tree === undefined ? ", tree clean" : (o.tree === null ? "" : `, tree ${o.tree}`)}`;

const runner = (over = {}) => (cwd, args) => {
  const key = args[0] === "rev-list" ? (args[2].startsWith("origin/") ? "aheadOfRunning" : "behind")
            : args[0] === "rev-parse" && args[1]?.startsWith("origin/") ? "localref"
            : args[0];
  const d = { "rev-parse": { ok: true, out: SHA },
              "symbolic-ref": { ok: true, out: "origin/main" },
              localref: { ok: true, out: "deadbeef" },
              "ls-remote": { ok: true, out: "deadbeef\trefs/heads/main" },
              aheadOfRunning: { ok: true, out: "0" },
              behind: { ok: true, out: "0" } };
  return over[key] ?? d[key] ?? { ok: false, out: "", err: "unexpected " + args.join(" ") };
};
const base = { run: runner(), plist: () => PLIST(ARGS), launchctl: () => LOADED,
               readLog: () => START(), home: "/h" };
const at = (io) => checkDaemonProvenance({ ...base, ...io });

const TABLE = [
  { name: "no job installed and none loaded is UNKNOWN, never OK",
    io: { plist: () => null, launchctl: () => null }, level: "UNKNOWN" },
  // NOTHING MAY SAY "RUNS" WITHOUT A LOADED JOB. The installed file describes the
  // next load; reading it alone would certify a guardian that is not there.
  { name: "a readable plist with NO loaded job is UNKNOWN, not OK",
    io: { launchctl: () => null }, level: "UNKNOWN",
    why: "the file says what WOULD run; it cannot establish that anything is running" },
  { name: "a loaded job that runs something other than bin/reeve is UNKNOWN",
    io: { launchctl: () => "arguments = {\n\t/usr/bin/true\n}\n" }, level: "UNKNOWN" },
  { name: "a path that is not a git checkout is BROKEN",
    io: { run: runner({ "rev-parse": { ok: false, out: "", err: "not a git repository" } }) }, level: "BROKEN" },
  // AN UNREADABLE STARTUP IS NOT A HEALTHY ONE. Appending a warning and returning
  // OK lets doctor exit healthy while admitting it cannot say what is running.
  { name: "no readable startup record is UNKNOWN, not OK",
    io: { readLog: () => "" }, level: "UNKNOWN" },
  { name: "a daemon that recorded its own commit as unreadable is UNKNOWN",
    io: { readLog: () => START({ commit: "unreadable" }) }, level: "UNKNOWN" },
  // RECORDED AT STARTUP, not read now: today's `git status` describes a different
  // moment than the one the process loaded from.
  { name: "a process that loaded from a DIRTY tree is BROKEN",
    io: { readLog: () => START({ tree: "dirty" }) }, level: "BROKEN",
    why: "what runs is not that commit and is not any commit" },
  // THE RUNNING REVISION IS THE ONE THAT MATTERS. Returning DEGRADED for any
  // divergence before the ancestry check let a daemon running an unreviewed
  // commit escape BROKEN as soon as the checkout moved to a reviewed HEAD.
  { name: "a RUNNING commit the branch has never seen is BROKEN even when the checkout moved",
    io: { readLog: () => START({ commit: "0ldc0de" }),
          run: runner({ aheadOfRunning: { ok: true, out: "3" } }) }, level: "BROKEN",
    why: "the divergence must not downgrade an unreviewed running commit to DEGRADED" },
  { name: "a STALE tracking ref is UNKNOWN rather than unreviewed code",
    io: { run: runner({ localref: { ok: true, out: "0000old" },
                        aheadOfRunning: { ok: true, out: "2" } }) }, level: "UNKNOWN" },
  { name: "a comparison that could not RUN is UNKNOWN, not unreviewed code",
    io: { run: runner({ aheadOfRunning: { ok: false, out: "", err: "unknown revision" } }) }, level: "UNKNOWN" },
  { name: "a checkout that moved after startup is DEGRADED",
    io: { readLog: () => START({ commit: "0ldc0de" }) }, level: "DEGRADED" },
  { name: "the running commit at the default branch is OK", io: {}, level: "OK" },
  { name: "behind the default branch is still OK, because pinning is legitimate",
    io: { run: runner({ behind: { ok: true, out: "43" } }) }, level: "OK" },
];

for (const { name, io, level, why } of TABLE) {
  const r = at(io);
  check(r.level === level, name, `${r.level} (wanted ${level})${why ? " -- " + why : ""}\n        ${(r.lines ?? []).join("\n        ")}`);
}

// ── the LOADED job outranks the installed file ───────────────────────────────
{
  const r = at({ plist: () => PLIST(["/n/bin/node", "/edited/path/bin/reeve"]) });
  const text = r.lines.join(" ");
  check(/\/Users\/x\/deploy/.test(text), "the LOADED arguments decide which checkout is measured", text);
  check(/has not been reloaded/.test(text), "and a plist that disagrees is itself reported", text);
}

// ── the rule does not claim what it has not measured ─────────────────────────
{
  const text = at({ run: runner({ behind: { ok: true, out: "43" } }) }).lines.join(" ");
  check(/43 commit\(s\) behind/.test(text), "it states the distance as a number", text);
  check(!/pinned, not drifting/.test(text), "and does NOT assert the distance was deliberate", text);
  check(!/promoted commit/.test(text), "nor calls an unrecorded HEAD a promoted one", text);
  // A daemon predating the tree record must not read as having loaded a clean one.
  const older = at({ readLog: () => START({ tree: null }) }).lines.join(" ");
  check(/older daemon/.test(older), "an absent tree record says so instead of being read as clean", older);
}

// ── the startup record ───────────────────────────────────────────────────────
{
  const r = startupRecordFrom(`noise\n${START({ pid: 63207, commit: "a939cb1" })}\ntail`);
  check(r?.pid === 63207 && r?.commit === "a939cb1" && r?.tree === "clean",
    "pid, commit and tree come from one anchored startup line", JSON.stringify(r));
  check(startupRecordFrom(`${START({ pid: 1 })}\n${START({ pid: 2 })}`)?.pid === 2,
    "the LAST start wins, because a daemon that restarted loaded the newer one");
  check(startupRecordFrom(START({ commit: "unreadable" }))?.commit === null,
    "an `unreadable` commit is a record, not a miss");
  check(startupRecordFrom(START({ tree: null }))?.tree === null,
    "an older daemon's record has no tree state, and absent is not clean");
  // A failing check named `running commit abcdef1` reaches the shared log through
  // describe(); an unanchored scan would let a check name decide what is running.
  // THE INJECTED LINE MUST CARRY THE SHAPE THE LOOSE PATTERN WOULD MATCH. A first
  // version wrote `check failed: running commit deadbee`, which has no `pid N,`
  // -- so the unanchored pattern did not match it either and the fixture passed
  // with the anchor removed. The sweep reported NOT_CAUGHT.
  check(startupRecordFrom(`${START({ commit: "aaaaaaa" })}\ncheck failed: build at pid 999, running commit deadbee`)?.commit === "aaaaaaa",
    "a later line merely CONTAINING the phrase is not read as a startup record");
  check(startupRecordFrom("") === null, "an empty log answers null rather than a value");
}

// ── the readers, alone ───────────────────────────────────────────────────────
{
  check(programArguments(PLIST(["a", "b"]))?.join(",") === "a,b", "ProgramArguments reads every string in order");
  check(programArguments("<plist></plist>") === null, "and answers null when there is no array to read");
  check(decodeXml("/Users/A &amp; B") === "/Users/A & B", "a plist string is XML-decoded before it is used as a path");
  check(programArguments(PLIST(["/Users/A &amp; B/bin/reeve"]))[0] === "/Users/A & B/bin/reeve",
    "and the decoding happens where the arguments are read");
  check(checkoutFromArgs(ARGS, { realpath: (p) => p }) === "/Users/x/deploy",
    "the checkout is the parent of the bin/ that holds reeve");
  check(checkoutFromArgs(["/usr/local/bin/reeve"], { realpath: () => "/checkout/bin/reeve" }) === "/checkout",
    "a SYMLINKED entry point resolves to the checkout that holds the code");
  // `node bin/reeve` with a WorkingDirectory is a valid job; the relative argument
  // means nothing from wherever doctor happens to be running.
  check(checkoutFromArgs(["bin/reeve"], { realpath: (p) => p, cwd: "/jobdir" }) === "/jobdir",
    "a RELATIVE entry point resolves against the job's working directory");
  check(checkoutFromArgs(["bin/reeve"], { realpath: (p) => p }) === null,
    "control: and is refused rather than guessed when that directory is unknown");
  check(checkoutFromArgs(["/usr/bin/reeved"], { realpath: (p) => p }) === null,
    "control: a path merely CONTAINING reeve is not bin/reeve");
  check(loadedArguments(LOADED)?.length === 4, "launchctl's loaded arguments are read in order");
  check(loadedArguments("no arguments block") === null, "and answer null when launchctl reports none");
  // bin/reeve resolves the log as `opt("log") ?? join(HOME, "reeve.log")`, so both
  // move it away from doctor's own home.
  check(daemonLogPath(["run", "--log", "/custom/d.log"], {}, "/h") === "/custom/d.log",
    "the --log argument decides where the daemon writes");
  check(daemonLogPath(["run"], { REEVE_HOME: "/jobhome" }, "/h") === "/jobhome/reeve.log",
    "and the JOB's REEVE_HOME decides it when --log is absent");
  check(daemonLogPath(["run"], {}, "/h") === "/h/reeve.log", "control: falling back to the given home");
  check(loadedEnvironment("environment = {\n\tREEVE_HOME => /jobhome\n}\n").REEVE_HOME === "/jobhome",
    "the job's environment is read from launchctl");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
