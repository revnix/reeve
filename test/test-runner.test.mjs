// The suite's runner, scripts/test.mjs, which `npm test` runs (#220).
//
// It runs every test file but the escape probe, in order, stopping at the first
// that fails, each under a temporary folder of the run's own. That folder goes
// however the run ends: finished, failed, or stopped by SIGINT or SIGTERM,
// which the runner passes to the test that is running before it ends by the
// same signal. Each case runs the runner on a folder of stand-in test files,
// with TMPDIR set to an empty folder, and looks at what's left there.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runner = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "test.mjs");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// A folder of stand-in test files, from `{ name: body }`.
const suite = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "reeve-suite-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
};
// Each stand-in makes a folder under the temp directory, as a test does, and
// says it ran.
const test = (name, end = "") => `import { mkdtempSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
  mkdtempSync(join(tmpdir(), "reeve-t-")); console.log(${JSON.stringify(`${name} ran`)}); ${end}`;
const env = (tmp) => ({ ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp });

const dirs = [];
try {
  // In order, stopping at the first failure; the escape probe never runs.
  const failing = suite({ "a.test.mjs": test("a"), "b.test.mjs": test("b", "process.exit(1);"), "c.test.mjs": test("c"),
                          "escape.test.mjs": test("escape", "process.exit(1);") });
  const passing = suite({ "a.test.mjs": test("a"), "c.test.mjs": test("c"), "escape.test.mjs": test("escape", "process.exit(1);"),
                          "notes.mjs": test("notes", "process.exit(1);") });
  dirs.push(failing, passing);
  const tmp = mkdtempSync(join(tmpdir(), "reeve-runner-"));
  dirs.push(tmp);
  const failed = spawnSync(process.execPath, [runner, failing], { env: env(tmp), encoding: "utf8", timeout: 60_000 });
  const leftAfterFailure = readdirSync(tmp);
  const passed = spawnSync(process.execPath, [runner, passing], { env: env(tmp), encoding: "utf8", timeout: 60_000 });
  check(failed.status === 1 && /a ran/.test(failed.stdout) && /b ran/.test(failed.stdout) && !/c ran/.test(failed.stdout),
    "the runner runs the test files in order and stops at the first that fails", JSON.stringify({ status: failed.status, out: failed.stdout }));
  check(passed.status === 0 && /a ran/.test(passed.stdout) && /c ran/.test(passed.stdout) && !/escape ran|notes ran/.test(passed.stdout),
    "and passes when every one does, running only test files and never the escape probe", JSON.stringify({ status: passed.status, out: passed.stdout }));
  check(/a ran/.test(failed.stdout) && /a ran/.test(passed.stdout) && leftAfterFailure.length === 0 && readdirSync(tmp).length === 0,
    "what the tests leave in the temp directory is gone once the run ends, passed or failed",
    JSON.stringify({ leftAfterFailure, left: readdirSync(tmp) }));

  // Stopped by a signal while a test is busy in synchronous code, the runner
  // passes the signal on, removes the run's folder, and ends by that signal.
  // Windows has no signals to send: there, process.kill ends a process outright.
  if (process.platform !== "win32") {
    const busy = suite({ "busy.test.mjs": test("busy", "const end = Date.now() + 20_000; while (Date.now() < end) {}") });
    dirs.push(busy);
    const stopped = [];
    for (const sig of ["SIGTERM", "SIGINT"]) {
      const tmp = mkdtempSync(join(tmpdir(), "reeve-runner-"));
      dirs.push(tmp);
      stopped.push(await new Promise((resolve) => {
        const child = spawn(process.execPath, [runner, busy], { env: env(tmp), stdio: ["ignore", "pipe", "ignore"] });
        let sentAt = null;
        child.stdout.on("data", (d) => { if (sentAt === null && /busy ran/.test(String(d))) { sentAt = Date.now(); child.kill(sig); } });
        child.on("exit", (status, signal) => resolve({ sig, status, signal, ms: sentAt === null ? null : Date.now() - sentAt, left: readdirSync(tmp) }));
      }));
    }
    check(stopped.every(({ sig, signal, ms, left }) => signal === sig && ms !== null && ms < 5_000 && left.length === 0),
      "stopped by SIGTERM or SIGINT, the runner ends the busy test at once, removes the run's folder, and ends by that signal",
      JSON.stringify(stopped));

    // A test that catches SIGTERM keeps running through the grace period. A
    // second SIGTERM then must not end the runner before it has cleaned up.
    // The grace is cut to 3 seconds here, and the stand-in ends itself after 8,
    // so nothing outlives the case.
    const stubborn = suite({ "stubborn.test.mjs": test("stubborn", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 8_000);") });
    const tmp2 = mkdtempSync(join(tmpdir(), "reeve-runner-"));
    dirs.push(stubborn, tmp2);
    const twice = await new Promise((resolve) => {
      const child = spawn(process.execPath, [runner, stubborn], { env: { ...env(tmp2), REEVE_TEST_GRACE_MS: "3000" }, stdio: ["ignore", "pipe", "ignore"] });
      let sentAt = null;
      child.stdout.on("data", (d) => {
        if (sentAt !== null || !/stubborn ran/.test(String(d))) return;
        sentAt = Date.now();
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGTERM"), 500);
      });
      child.on("exit", (status, signal) => resolve({ status, signal, ms: sentAt === null ? null : Date.now() - sentAt, left: readdirSync(tmp2) }));
    });
    check(twice.signal === "SIGTERM" && twice.ms !== null && twice.ms >= 2_500 && twice.left.length === 0,
      "a second SIGTERM while a test outlasts the first doesn't end the runner before it removes the run's folder",
      JSON.stringify(twice));
  }

  // A run with no test file in its folder ran nothing, and fails.
  const empty = suite({ "notes.mjs": test("notes") });
  const tmp3 = mkdtempSync(join(tmpdir(), "reeve-runner-"));
  dirs.push(empty, tmp3);
  const none = spawnSync(process.execPath, [runner, empty], { env: env(tmp3), encoding: "utf8", timeout: 60_000 });
  check(none.status === 1 && readdirSync(tmp3).length === 0, "a run with no test file to run fails, rather than passing on nothing",
    JSON.stringify({ status: none.status, err: none.stderr, left: readdirSync(tmp3) }));
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
