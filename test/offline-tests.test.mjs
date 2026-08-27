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
writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 1\n`);
chmodSync(shim, 0o755);

const runUnderShim = (script, extraEnv = {}) => {
  if (existsSync(log)) rmSync(log);
  const r = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, PATH: `${shimDir}:${process.env.PATH}`,
           REEVE_HOME: join(dir, ".reeve"), ...extraEnv },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
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
  check(r.calls[0] === "api repos/o/r",
    "control: and records the arguments it was called with", JSON.stringify(r.calls[0]));
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
const KNOWN_LIVE = /^api repos\/[^/]+\/[^/]+\/pulls\/\d+ --jq \[\.state, \.merged,/;

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

  const unexpected = r.calls.filter(c => !KNOWN_LIVE.test(c));
  check(unexpected.length === 0,
    `${script} makes no live GitHub read except the one known to remain`,
    unexpected.length ? `${unexpected.length} unexpected: ${JSON.stringify(unexpected.slice(0, 3))}` : "");

  // And the allowance itself is asserted to be REACHED, so that when
  // `reconcilePr` finally gets its seam this line goes red and the exception is
  // deleted rather than left standing over nothing. An allowance nobody has to
  // remove is an allowance that outlives its reason.
  check(r.calls.some(c => KNOWN_LIVE.test(c)),
    `${script} still exercises the un-seamed reconcilePr read, so the allowance above is still needed`,
    `total recorded: ${r.calls.length}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
