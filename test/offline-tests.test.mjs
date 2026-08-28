// The tests that must never reach GitHub, and a check that they do not.
//
// The suite used to spend most of its wall clock waiting for 404s. The daemon
// tests tick against `o/r`, which does not exist, so every unstubbed read went
// to api.github.com and came back Not Found -- correct behaviour, no assertion
// changed by it, and roughly five minutes a run. Measured on the two heaviest
// files: 321s of real network against 17s with the reads stubbed, with PASS and
// FAIL output byte-identical either way.
//
// The fix was to stub the seams the daemon already exposes. This file is what
// stops it coming back. A reinstated live read is invisible in the ordinary way
// -- the file still passes, only slower -- so nothing but an explicit probe
// notices, and "slower" is exactly the signal a developer learns to ignore.
//
// It works by putting a `gh` first on PATH that records the call and exits
// non-zero, running each declared file under it, and asserting the recording is
// empty. The recorder must be shown to work before its silence means anything,
// which is what the control at the bottom does.

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-offline-"));
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// The files that tick the daemon and must resolve every GitHub read through an
// injected seam. Adding a file here is a promise that it needs no network; a
// file NOT here is not thereby permitted to reach out, it is merely unmeasured
// by this check, and saying so is the difference between a guard and a claim.
const OFFLINE = [
  "test/dispatch-e2e.test.mjs",
  "test/guardian-provider-lease.test.mjs",
];

// A `gh` that answers nothing and writes down that it was asked. Exits 1,
// because that is what an unauthenticated `gh` does in CI and the code under
// test already handles it -- a recorder that exits 0 would return empty output
// as though it were a successful read, and change the behaviour it is measuring.
const shimDir = join(dir, "bin");
const log = join(dir, "calls.txt");
spawnSync("mkdir", ["-p", shimDir]);
const shim = join(shimDir, "gh");
// Records ARGV, not a joined command line. `"$*"` would flatten the arguments
// into one string, and every later comparison would then be a substring test
// against text -- which cannot tell an extra flag from a longer path, and reads
// a different call as the same one whenever the start of it matches.
// Unit Separator delimits, because it cannot occur inside a real `gh` argument.
const US = "\x1f";
writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$(printf '%s${US}' "$@")" >> ${JSON.stringify(log)}\nexit 1\n`);
chmodSync(shim, 0o755);

const runUnderShim = (script, extraEnv = {}) => {
  if (existsSync(log)) rmSync(log);
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`,
           REEVE_HOME: join(dir, ".reeve"), ...extraEnv },
  });
  // Each recorded line is one invocation, its arguments separated by US and a
  // trailing separator from the printf, which the filter drops.
  const calls = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean).map(l => l.split(US).filter(a => a !== ""))
    : [];
  return { status: r.status, calls, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

// --- the control, FIRST, so a silent recorder cannot read as a clean sweep ----
// A script that deliberately execs `gh`. If the recorder cannot see this, every
// result below is vacuous, and the file says so rather than reporting success.
{
  const probe = join(dir, "probe.mjs");
  writeFileSync(probe, `import { spawnSync } from "node:child_process";\n` +
                       `spawnSync("gh", ["api", "repos/o/r"], { encoding: "utf8" });\n`);
  const r = runUnderShim(probe);
  check(r.calls.length === 1,
    "control: the recorder sees a gh call when one is made",
    `recorded ${r.calls.length}: ${JSON.stringify(r.calls)}`);
  check(JSON.stringify(r.calls[0]) === JSON.stringify(["api", "repos/o/r"]),
    "control: and records each argument separately, not as one joined string",
    JSON.stringify(r.calls[0]));
  // The separator must survive an argument containing spaces, or the structured
  // comparison below degrades to the string matching it exists to replace.
  {
    const spacey = join(dir, "spacey.mjs");
    writeFileSync(spacey, `import { spawnSync } from "node:child_process";\n` +
                          `spawnSync("gh", ["api", "x", "--jq", "a b | @tsv"], { encoding: "utf8" });\n`);
    const rs = runUnderShim(spacey);
    check(JSON.stringify(rs.calls[0]) === JSON.stringify(["api", "x", "--jq", "a b | @tsv"]),
      "control: an argument containing spaces stays one argument",
      JSON.stringify(rs.calls[0]));
  }
}

// A second control, for the other direction: a script that runs no command at
// all must record nothing. Without it, a recorder that appends unconditionally
// would make every file look guilty and the check would be equally useless.
{
  const quiet = join(dir, "quiet.mjs");
  writeFileSync(quiet, `process.exit(0);\n`);
  const r = runUnderShim(quiet);
  check(r.calls.length === 0,
    "control: and records nothing when nothing is called", JSON.stringify(r.calls));
}

// One live read is KNOWN to remain, and it is named rather than tolerated.
//
// `reconcilePr` (src/github/reconciler.mjs) builds its own `gh` internally: no
// `io` parameter, and the daemon calls it directly rather than through a `ctx`
// seam, so a test cannot replace it the way it replaces `observe` and
// `evaluate`. Giving it a seam is a change to guardian source with an open pull
// request against it, so it is deliberately NOT bundled here.
//
// The allowance is written as a SHAPE, not a count. A number would drift
// silently as tests are added or removed and would still pass while something
// entirely different started reaching out; matching the argv means a NEW kind of
// live read fails this file even if the total happens to go down.
// The COMPLETE invocation, matched element by element. An earlier version of
// this matched a PREFIX of the joined command line, which would have waved
// through any future read of the same endpoint whose jq merely started the same
// way -- a different projection, or an extra flag, classified as the known
// exception. `reconcilePr` builds exactly four arguments
// (src/github/reconciler.mjs:40: `["api", path]` then `push("--jq", jq)`), so
// the length is part of the identity: an added flag makes it five and fails.
const KNOWN_JQ =
  '[.state, .merged, .head.ref, .base.ref, (.merge_commit_sha // ""), .title] | @tsv';
const isKnownLive = (argv) =>
  argv.length === 4 &&
  argv[0] === "api" &&
  /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(argv[1]) &&
  argv[2] === "--jq" &&
  argv[3] === KNOWN_JQ;

// The allowance is the one place this file tolerates a live read, so it gets
// its own controls. Every case below is a NEAR MISS that a prefix match over the
// joined command line would have accepted -- which is exactly what the earlier
// version did, and what these lines exist to keep out.
{
  const real = ["api", "repos/o/r/pulls/42", "--jq", KNOWN_JQ];
  check(isKnownLive(real), "the allowance accepts reconcilePr's actual call", JSON.stringify(real));

  const nearMisses = [
    [["api", "repos/o/r/pulls/42", "--jq", KNOWN_JQ, "--paginate"],
     "an extra flag on the same endpoint"],
    [["api", "repos/o/r/pulls/42", "--jq", '[.state, .merged, .author] | @tsv'],
     "a different projection that starts the same way"],
    [["api", "repos/o/r/pulls/42/reviews", "--jq", KNOWN_JQ],
     "a different endpoint under the same prefix"],
    [["api", "repos/o/r/pulls/42"],
     "the same endpoint with the projection dropped"],
    [["graphql", "repos/o/r/pulls/42", "--jq", KNOWN_JQ],
     "a graphql call wearing the same arguments"],
  ];
  for (const [argv, what] of nearMisses) {
    check(!isKnownLive(argv), `the allowance refuses ${what}`, JSON.stringify(argv));
  }
}

// --- the guard ---------------------------------------------------------------
for (const script of OFFLINE) {
  const r = runUnderShim(script);
  // The file must still PASS. A file that stopped reaching GitHub by crashing
  // early would satisfy an empty recording while proving nothing, which is the
  // shape this repository keeps finding: absence read as success.
  const passes = (r.out.match(/^PASS/gm) ?? []).length;
  const fails = (r.out.match(/^FAIL/gm) ?? []).length;
  check(r.status === 0 && passes > 0 && fails === 0,
    `${script} still passes with no network available`,
    `exit=${r.status} PASS=${passes} FAIL=${fails}`);

  const unexpected = r.calls.filter(c => !isKnownLive(c));
  check(unexpected.length === 0,
    `${script} makes no live GitHub read except the one known to remain`,
    unexpected.length ? `${unexpected.length} unexpected: ${JSON.stringify(unexpected.slice(0, 3))}` : "");

  // And the allowance itself is asserted to be REACHED, so that when
  // `reconcilePr` finally gets its seam this line goes red and the exception is
  // deleted rather than left standing over nothing. An allowance nobody has to
  // remove is an allowance that outlives its reason.
  check(r.calls.some(isKnownLive),
    `${script} still exercises the un-seamed reconcilePr read, so the allowance above is still needed`,
    `total recorded: ${r.calls.length}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
