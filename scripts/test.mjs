#!/usr/bin/env node
// The suite, as `npm test` runs it: every test file but the escape probe, in
// order, stopping at the first that fails. `node scripts/test.mjs [folder]`
// runs another folder's instead of test/.
//
// Each test runs with TMPDIR, TEMP and TMP set to a folder of this run's own,
// which is removed however the run ends: finished, failed, or stopped by SIGINT
// or SIGTERM. A test can't clean up on a signal itself: a listener switches the
// signal's default action off, and Node runs it only between tasks, so a test
// busy in synchronous code would never stop (#220). This runner only waits on
// its tests, so its listeners always run. It passes the signal to the test that
// is running, which ends by the default action, removes the folder once that
// test has ended, and then ends by the same signal, so whatever sent it sees
// why it stopped.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A test that listens for the signal itself and keeps running is killed after
// this long.
const GRACE_MS = 10_000;

const dir = process.argv[2] ?? "test";
const files = readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && f !== "escape.test.mjs").sort();
const run = mkdtempSync(join(tmpdir(), "reeve-test-"));
const env = { ...process.env, TMPDIR: run, TEMP: run, TMP: run };
const remove = () => rmSync(run, { recursive: true, force: true });

let current = null, stopping = null;
// Ends the run by `signal`: this runner's own listener for it is gone by now,
// so the signal's default action applies.
const endBy = (signal) => { remove(); process.kill(process.pid, signal); };
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping ??= signal;
    if (!current) return endBy(stopping);
    current.kill(signal);
    setTimeout(() => current?.kill("SIGKILL"), GRACE_MS).unref();
  });
}

for (const file of files) {
  current = spawn(process.execPath, [join(dir, file)], { stdio: "inherit", env });
  const code = await new Promise((resolve) => current.on("exit", (status) => resolve(status)));
  current = null;
  if (stopping) { endBy(stopping); await new Promise(() => {}); }
  if (code !== 0) { remove(); process.exit(1); }
}
remove();
