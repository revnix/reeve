// scripts/state.mjs, at its decision points.
//
// This script replaced a fenced bash block that lived in a handoff document and
// was the FIRST thing a resumed session ran. Two of its defects were the same
// shape -- a guard that alarms on success -- and the resume instructions say to
// stop when it fails, so both would have halted a session on a healthy
// repository. Neither was catchable, because markdown is not tested.
//
// Every assertion below is about telling a MEASUREMENT from a REFUSAL. That is
// the only thing this script does that can be wrong in a way nobody notices.
import { startupRecordFrom, schemaVersionFrom, unopenedBranches, sweepVerdict,
         nodeFloorFailure, parseArgs, daemonPidFrom } from "../scripts/state.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── the runtime, before anything else runs ───────────────────────────────────
{
  // package.json requires >=24.10 for node:sqlite, and the shell default on the
  // documented host is v22. The block this replaced prepended the Node 24 path
  // for exactly that reason; a bare shebang inherits PATH and would produce a
  // full report under a runtime the suite cannot run on.
  check(nodeFloorFailure("v24.17.0") === null, "a supported runtime is accepted");
  check(nodeFloorFailure("v25.0.0") === null, "and so is a newer major");
  check(nodeFloorFailure("v24.10.0") === null, "control: the floor itself is supported, not rejected");
  check(nodeFloorFailure("v22.18.0") !== null, "the documented host's DEFAULT node is refused");
  check(nodeFloorFailure("v24.9.0") !== null, "control: a minor below the floor is refused, not rounded up");
  check(nodeFloorFailure("banana") !== null, "and an unreadable version is a refusal rather than a pass");
}

// ── arguments ────────────────────────────────────────────────────────────────
{
  check(parseArgs(["--sweep"]).sweep === true, "--sweep asks for the verification");
  check(parseArgs([]).sweep === false, "and its absence does not");
  // A mistyped flag silently skipping the gate makes an ABSENT verification look
  // like an ordinary clean report, which is this file's whole failure mode.
  check(typeof parseArgs(["--swep"]).error === "string",
    "a MISTYPED flag is refused rather than ignored", JSON.stringify(parseArgs(["--swep"])));
  check(typeof parseArgs(["--sweep", "--force"]).error === "string",
    "control: an unknown flag alongside a known one is still refused");
}

// ── the startup record: pid and commit, from one anchored line ──────────────
//
// The format is owned by src/daemon.mjs, which writes
//   reeve daemon starting — node vX, pid N, running commit <sha|unreadable>
{
  // THE SHAPE THE DAEMON ACTUALLY WRITES, timestamp included. `log()` prefixes an
  // ISO stamp, so a record never starts its line -- an earlier `^reeve daemon`
  // anchor matched nothing at all and the script refused on a healthy daemon.
  const LINE = (pid, c) => `2026-09-02T11:29:05.914Z reeve daemon starting — node v24.17.0, pid ${pid}, running commit ${c}`;

  const r = startupRecordFrom(`noise\n${LINE(63207, "a939cb1")}\nmore`);
  check(r?.pid === 63207 && r?.commit === "a939cb1", "pid and commit come from the SAME startup line", JSON.stringify(r));

  check(startupRecordFrom(`${LINE(1, "aaaaaaa")}\n${LINE(2, "bbbbbbb")}`)?.pid === 2,
    "the LAST start wins, because a daemon that restarted loaded the newer one");

  // `runningCommit()` returns the literal string when its own git rev-parse
  // fails, deliberately. Scanning past it to an older start would attribute that
  // start's commit to the process running now -- worse than answering nothing.
  const u = startupRecordFrom(`${LINE(9, "aaaaaaa")}\n${LINE(10, "unreadable")}`);
  check(u?.pid === 10 && u?.commit === null,
    "an `unreadable` commit is a RECORD, not a miss: it does not fall back to an older start",
    JSON.stringify(u));

  // A bare `running commit <sha>` matches anywhere in a shared log whose later
  // lines carry externally influenced text -- a GitHub check named
  // "running commit abcdef1" reaches the log through describe().
  // THE INJECTED LINE MUST CARRY THE SHAPE THE LOOSE PATTERN WOULD MATCH.
  // A first version wrote `check failed: running commit deadbee`, which has no
  // `pid N,` -- so an unanchored `pid (\d+), running commit (\S+)` did not match
  // it either and the fixture passed with the anchor removed. The stub sweep
  // reported NOT_CAUGHT; a fixture that cannot exhibit the defect proves nothing.
  check(startupRecordFrom(`${LINE(5, "aaaaaaa")}\ncheck failed: build at pid 999, running commit deadbee`)?.commit === "aaaaaaa",
    "a later line merely CONTAINING the phrase is not read as a startup record");
  // ANCHORING ON THE PHRASE WAS NOT ENOUGH. A first fix required `reeve daemon
  // starting` and still accepted it mid-line; only ^...$ closes it.
  check(startupRecordFrom(`${LINE(5, "aaaaaaa")}\nfailing: reeve daemon starting x pid 999, running commit deadbee`)?.commit === "aaaaaaa",
    "nor is a decision line that QUOTES the whole phrase inside itself");
  check(startupRecordFrom(`${LINE(7, "ccccccc")}, tree clean`)?.commit === "ccccccc",
    "a newer daemon's appended tree state does not break the read");

  check(startupRecordFrom("") === null, "an empty log answers null rather than a value");
  check(startupRecordFrom(null) === null, "and so does no log at all");
  check(startupRecordFrom("reeve daemon starting, no pid or commit here") === null,
    "and so does a start that records neither");
}

// ── liveness is not a log line ───────────────────────────────────────────────
{
  // `reeve.log` is append-only and the startup record precedes the daemon's own
  // Node-floor assertion, so a process that started and immediately exited leaves
  // a line indistinguishable from a healthy one. Reporting `running` from that
  // alone is an absence read as success, indefinitely.
  check(daemonPidFrom("\tstate = running\n\tpid = 63207\n") === 63207,
    "the pid is read from what launchctl reports about the loaded job");
  check(daemonPidFrom("\tstate = not running\n") === null,
    "a loaded job with NO pid is not a running one");
  check(daemonPidFrom("") === null, "control: no launchctl output names no pid");
  check(daemonPidFrom(null) === null, "control: and neither does none at all");
}

// ── the read that used to refuse on success ──────────────────────────────────
{
  check(schemaVersionFrom("export const HUB_SCHEMA_VERSION = 6;") === 6,
    "the schema version is read from the source that declares it");
  check(schemaVersionFrom("nothing here") === null, "and is null when nothing declares it");
  // The defect was never in the parse: `git show <ref>:<path> | grep -m1 PAT`
  // under pipefail reports 141, because grep exits first and git show takes
  // SIGPIPE. This takes TEXT, so no pipeline exists to report a failure the read
  // did not have.
  check(schemaVersionFrom("export const HUB_SCHEMA_VERSION = 6;\nexport const OTHER = 9;") === 6,
    "control: it takes the version it names, not the next number in the file");
  // THE DECLARATION, not any mention of it. A comment carrying an example before
  // the real line would otherwise decide the next migration number.
  check(schemaVersionFrom("// for example HUB_SCHEMA_VERSION = 3\nexport const HUB_SCHEMA_VERSION = 7;") === 7,
    "an example in a comment does not outrank the exported declaration");
}

// ── unopened work, keyed on the COMMIT ───────────────────────────────────────
{
  const b = (name, oid) => ({ name, oid });
  check(unopenedBranches([b("a", "1"), b("b", "2")], ["2"]).map(x => x.name).join(",") === "a",
    "a branch whose HEAD COMMIT a pull request claims is not unopened work");
  // A NAME IS REUSED. Keying on it marks the name claimed for ever, so the next
  // branch of that name never appears -- and a fork's pull request carries a
  // same-named head that has nothing to do with this repository's branch.
  check(unopenedBranches([b("recycled", "new-oid")], ["old-oid"]).length === 1,
    "a REUSED branch name with new commits is still unopened work",
    "keying on the name would have hidden it for ever");
  check(unopenedBranches([], []).length === 0, "control: nothing in, nothing out");
}

// ── THE DISCRIMINATION THIS SCRIPT EXISTS FOR ────────────────────────────────
//
// A sweep exits non-zero for two unrelated reasons, and calling them one thing is
// what sent a session hunting a defect in a healthy repository. main's CI was
// green on the same commit the block called broken.
{
  const SUMMARY = "229/229 stub(s) caught\n229 entries over 30 of 125 test file(s)";
  const notCaught = { ok: false, out: "228/229 stub(s) caught\n  · some-entry: NOT_CAUGHT" };
  const unrunnable = { ok: false, out: "228/229 stub(s) caught\n  · lint-rule-reports-a-pathname-read: UNRUNNABLE" };

  check(sweepVerdict(notCaught).level === "refusal",
    "an assertion that CANNOT FAIL is a refusal -- the finding the sweep exists to produce");
  check(sweepVerdict(unrunnable).level === "environment",
    "an entry that could not RUN is a fact about this machine, not about the code");
  // UNRUNNABLE is NOT only a dependency problem: stubsweep emits it when the
  // control is already red on the base, when a restore fails, and when a test
  // leaves side effects. Naming dependencies as the cause misdirects three times
  // out of four.
  check(!/check dependencies are installed/.test(sweepVerdict(unrunnable).lines.join(" ")),
    "and it does not name dependencies as THE cause, since three other causes share the verdict",
    sweepVerdict(unrunnable).lines.join(" "));
  check(/control already red|failed restore|side effects/.test(sweepVerdict(unrunnable).lines.join(" ")),
    "it lists the causes that share the verdict instead");
  // BOTH STILL STOP THE CALLER: an entry that could not run produced no evidence,
  // so the verification is incomplete either way; only the sentence differs.
  check(sweepVerdict(unrunnable).stop === true,
    "an incomplete verification STOPS the caller, even though it is not a code finding");
  check(sweepVerdict(notCaught).stop === true, "and so does a real finding");
  check(sweepVerdict({ ok: true, out: SUMMARY }).stop === false,
    "control: only a sweep that actually passed lets the caller continue");

  // A ZERO EXIT IS NOT EVIDENCE. A sweep returning success without printing its
  // verdict would give `ok` with a blank line -- the exact absence read as
  // success that this file exists to prevent, in the function written to prevent
  // it.
  check(sweepVerdict({ ok: true, out: "" }).level === "refusal",
    "a clean exit that printed NO verdict is a refusal, not a pass",
    JSON.stringify(sweepVerdict({ ok: true, out: "" })));
  // A SUMMARY IS NOT A PASSING SUMMARY. `0/280 caught` matches the shape and
  // means every entry failed; and the coverage line can be absent after an early
  // return even when a verdict printed.
  check(sweepVerdict({ ok: true, out: "0/280 stub(s) caught\n280 entries over 31 of 126 test file(s)" }).level === "refusal",
    "a zero exit reporting 0 of 280 caught is a refusal, not a pass");
  check(sweepVerdict({ ok: true, out: "279/280 stub(s) caught\n280 entries over 31 of 126 test file(s)" }).level === "refusal",
    "and so is one short of complete");
  check(sweepVerdict({ ok: true, out: "280/280 stub(s) caught" }).level === "refusal",
    "a verdict with NO coverage line means the sweep did not finish");
  // EQUALITY IS NOT ENOUGH. `0/0 caught` satisfies it while having measured
  // nothing, and a coverage line whose entry count disagrees with the verdict's
  // total describes a different run than the one that just reported.
  check(sweepVerdict({ ok: true, out: "0/0 stub(s) caught\n0 entries over 30 of 125 test file(s)" }).level === "refusal",
    "a sweep that ran NO stubs is a refusal, however equal its counts");
  check(sweepVerdict({ ok: true, out: "229/229 stub(s) caught\n305 entries over 30 of 125 test file(s)" }).level === "refusal",
    "and a coverage line that counts different entries describes a different run");
  check(sweepVerdict({ ok: true, out: "229/229 stub(s) caught\n229 entries over 30 of 125 test file(s)" }).level === "ok",
    "control: agreeing counts over a non-zero total is the only clean pass");
  // `die()` writes the actionable reason to stderr only.
  check(/manifest is unusable/.test(sweepVerdict({ ok: false, out: "", err: "the manifest is unusable" }).lines.join(" ")),
    "a refusal carries the stderr that says what to do about it");
  check(sweepVerdict({ ok: true, out: "" }).stop === true, "and it stops the caller");
  check(sweepVerdict({ ok: true, out: "built fine, nothing to do" }).level === "refusal",
    "control: output without the `N/M stub(s) caught` line is still an absence");

  check(sweepVerdict({ ok: false, out: "  · a: NOT_CAUGHT\n  · b: UNRUNNABLE" }).level === "refusal",
    "control: a real finding alongside an unrunnable entry is still a refusal");
  check(sweepVerdict({ ok: false, out: "exploded" }).level === "refusal",
    "control: a failure naming no verdict at all is a refusal, not an environment note");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
