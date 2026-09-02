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
import { runningCommitFrom, schemaVersionFrom, unopenedBranches, sweepVerdict } from "../scripts/state.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── an absent reading is null, and null is a refusal ─────────────────────────
{
  check(runningCommitFrom("x\nreeve daemon starting — running commit a939cb1\ny") === "a939cb1",
    "the running commit is read from the log line that records it");
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

// ── the read that used to refuse on success ──────────────────────────────────
{
  check(schemaVersionFrom("export const HUB_SCHEMA_VERSION = 6;") === 6,
    "the schema version is read from the source that declares it");
  check(schemaVersionFrom("nothing here") === null, "and is null when nothing declares it");
  // The defect was never in the parse: `git show <ref>:<path> | grep -m1 PAT`
  // under pipefail reports 141, because grep exits first and git show takes
  // SIGPIPE. This function takes TEXT, so the fetch is the caller's problem and
  // no pipeline exists to report a failure the read did not have.
  check(schemaVersionFrom("export const HUB_SCHEMA_VERSION = 6;\nexport const OTHER = 9;") === 6,
    "control: it takes the version it names, not the next number in the file");
}

// ── unopened work ────────────────────────────────────────────────────────────
{
  check(unopenedBranches(["a", "b", "c"], ["b"]).join(",") === "a,c",
    "a branch claimed by a pull request is not unopened work");
  // main is squash-merged, so a MERGED branch's commits are literally absent
  // from main and count as ahead. Filtering on OPEN pull requests alone reported
  // 136 branches where about a dozen were real -- a list that long is one nobody
  // reads, which is the same failure as not reporting at all.
  check(unopenedBranches(["merged-long-ago"], ["merged-long-ago"]).length === 0,
    "including one whose pull request is long since closed");
  check(unopenedBranches([], []).length === 0, "control: nothing in, nothing out");
}

// ── THE DISCRIMINATION THIS SCRIPT EXISTS FOR ────────────────────────────────
//
// A sweep exits non-zero for two unrelated reasons, and calling them one thing
// is what sent a session hunting a defect in a healthy repository. main's CI was
// green on the same commit the block called broken.
{
  const notCaught = { ok: false, out: "228/229 stubs\n  · some-entry: NOT_CAUGHT" };
  const unrunnable = { ok: false, out: "228/229 stubs\n  · lint-rule-reports-a-pathname-read: UNRUNNABLE" };

  check(sweepVerdict(notCaught).level === "refusal",
    "an assertion that CANNOT FAIL is a refusal -- the finding the sweep exists to produce",
    sweepVerdict(notCaught).level);
  check(sweepVerdict(unrunnable).level === "environment",
    "an entry that could not RUN is a fact about this machine, not about the code",
    sweepVerdict(unrunnable).level);
  check(sweepVerdict(unrunnable).lines.join(" ").includes("dependencies"),
    "and it says so, naming the thing that is actually missing",
    sweepVerdict(unrunnable).lines.join(" "));
  check(sweepVerdict({ ok: true, out: "229 entries\n229/229 stub(s) caught" }).level === "ok",
    "a sweep that passed is not a refusal");
  // Both kinds at once: the real finding outranks the environment note, because
  // an assertion that cannot fail is true regardless of what else was missing.
  check(sweepVerdict({ ok: false, out: "  · a: NOT_CAUGHT\n  · b: UNRUNNABLE" }).level === "refusal",
    "control: a real finding alongside an unrunnable entry is still a refusal");
  check(sweepVerdict({ ok: false, out: "exploded" }).level === "refusal",
    "control: a failure naming no verdict at all is a refusal, not an environment note");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
