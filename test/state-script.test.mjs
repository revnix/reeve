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
import { runningCommitFrom, schemaVersionFrom, unopenedBranches, sweepVerdict,
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

// ── an absent reading is null, and null is a refusal ─────────────────────────
{
  check(runningCommitFrom("x\nreeve daemon starting — running commit a939cb1\ny") === "a939cb1",
    "the loaded commit is read from the log line that records it");
  check(runningCommitFrom("running commit aaaaaaa\nrunning commit bbbbbbb") === "bbbbbbb",
    "the LAST start wins, because a daemon that restarted loaded the newer one");
  // The shell version piped through `tail`, which exits 0 on empty input: a
  // missing log, an unreadable one, and one with no such record all printed a
  // blank line that read as a measurement.
  check(runningCommitFrom("") === null, "an empty log answers null rather than an empty string");
  check(runningCommitFrom(null) === null, "and so does no log at all");
  check(runningCommitFrom("reeve daemon starting, no commit here") === null,
    "and so does a log that starts a daemon without recording a commit");
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
  const notCaught = { ok: false, out: "228/229 stubs\n  · some-entry: NOT_CAUGHT" };
  const unrunnable = { ok: false, out: "228/229 stubs\n  · lint-rule-reports-a-pathname-read: UNRUNNABLE" };

  check(sweepVerdict(notCaught).level === "refusal",
    "an assertion that CANNOT FAIL is a refusal -- the finding the sweep exists to produce");
  check(sweepVerdict(unrunnable).level === "environment",
    "an entry that could not RUN is a fact about this machine, not about the code");
  check(sweepVerdict(unrunnable).lines.join(" ").includes("dependencies"),
    "and it says so, naming the thing that is actually missing");
  // BOTH STILL STOP THE CALLER. An entry that could not run produced no evidence,
  // so the verification is incomplete either way; only the sentence differs.
  // Reporting `environment` and exiting 0 would hand a resumed session an
  // incomplete verification wearing a clean exit.
  check(sweepVerdict(unrunnable).stop === true,
    "an incomplete verification STOPS the caller, even though it is not a code finding");
  check(sweepVerdict(notCaught).stop === true, "and so does a real finding");
  check(sweepVerdict({ ok: true, out: "229/229 stub(s) caught" }).stop === false,
    "control: only a sweep that actually passed lets the caller continue");
  check(sweepVerdict({ ok: false, out: "  · a: NOT_CAUGHT\n  · b: UNRUNNABLE" }).level === "refusal",
    "control: a real finding alongside an unrunnable entry is still a refusal");
  check(sweepVerdict({ ok: false, out: "exploded" }).level === "refusal",
    "control: a failure naming no verdict at all is a refusal, not an environment note");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
