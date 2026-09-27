#!/usr/bin/env node
// The suite, as `npm test` runs it: every test file but the escape probe, in
// order, stopping at the first that fails. `node scripts/test.mjs [folder]`
// runs another folder's instead of test/, and `node scripts/test.mjs
// <file>.test.mjs` runs that one file, as it runs each of the suite's.
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
//
// And each test stays on this machine (#243, #245):
// - test/fixtures/offline-gh comes first on its PATH: a gh that fails every
//   call, as a gh with no login does, and writes it down. A test never reaches
//   GitHub, so a file that called gh fails the run, with the calls it made.
// - its home is an empty folder of its own, and the caller's REEVE_HOME is
//   dropped. A test never writes into the real reeve home, where a running
//   daemon keeps its state, so a file that wrote a .reeve into its home fails
//   the run: it gives reeve a home of its own with REEVE_HOME.
// CI runs each file the same way.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A test that listens for the signal itself and keeps running is killed after
// this long. REEVE_TEST_GRACE_MS shortens it for the runner's own test.
const GRACE_MS = Number(process.env.REEVE_TEST_GRACE_MS) || 10_000;

const arg = process.argv[2] ?? "test";
const single = arg.endsWith(".test.mjs");
// The escape probe measures the sandbox against the real home and a real gh,
// which this runner takes away. It has a command of its own.
if (single && basename(arg) === "escape.test.mjs") {
  console.error("test: the escape probe runs against the real home and gh; run it with `npm run test:escape`");
  process.exit(1);
}
const dir = single ? dirname(arg) : arg;
const files = single ? [basename(arg)] : readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && f !== "escape.test.mjs").sort();
// A run that runs nothing proves nothing, and fails: the folder may be the
// wrong one, or its tests renamed.
if (!files.length) {
  console.error(`test: no test files in ${dir}`);
  process.exit(1);
}
const run = mkdtempSync(join(tmpdir(), "reeve-test-"));
// The tests' homes, and what their gh wrote down: outside their TMPDIR, so a
// test that looks at its temp folder doesn't find them there.
const own = mkdtempSync(join(tmpdir(), "reeve-test-own-"));
const offlineGh = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures", "offline-gh");
const env = { ...process.env, TMPDIR: run, TEMP: run, TMP: run, PATH: `${offlineGh}${delimiter}${process.env.PATH ?? ""}` };
delete env.REEVE_HOME;
const remove = () => { for (const d of [run, own]) rmSync(d, { recursive: true, force: true }); };

let current = null, stopping = null, grace = null;
// The listeners stay until the folder is gone, so a second signal, while a
// test that caught the first is still running, is passed on too rather than
// ending the runner before it has cleaned up.
const onSignal = (signal) => {
  stopping ??= signal;
  if (!current) return endBy(stopping);
  current.kill(signal);
  grace ??= setTimeout(() => current?.kill("SIGKILL"), GRACE_MS).unref();
};
// Ends the run by `signal`. Its listeners come off only now, so the signal's
// default action applies.
const endBy = (signal) => {
  remove();
  for (const s of ["SIGINT", "SIGTERM"]) process.removeListener(s, onSignal);
  process.kill(process.pid, signal);
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, onSignal);

// What a file did that a test never does.
const strayed = (file, home, ghLog) => {
  const found = [];
  const calls = existsSync(ghLog) ? readFileSync(ghLog, "utf8").split("\x1e").filter(Boolean) : [];
  if (calls.length) {
    const shown = calls.slice(0, 5).map((c) => `  gh ${c.split("\x1f").slice(0, -1).join(" ").replace(/\s+/g, " ").slice(0, 200)}`);
    found.push(`test: ${file} called gh ${calls.length} time(s), and a test never reaches GitHub. Give each read a stand-in:\n${shown.join("\n")}`);
  }
  if (existsSync(join(home, ".reeve")))
    found.push(`test: ${file} wrote into its home's .reeve, and a test never writes into the real one. Give reeve a home of its own with REEVE_HOME.`);
  return found;
};

for (const [i, file] of files.entries()) {
  const home = join(own, `home-${i}`);
  mkdirSync(home);
  const ghLog = join(own, `gh-${i}.log`);
  current = spawn(process.execPath, [join(dir, file)], { stdio: "inherit", env: { ...env, HOME: home, REEVE_TEST_GH_LOG: ghLog } });
  const code = await new Promise((resolve) => current.on("exit", (status) => resolve(status)));
  current = null;
  if (stopping) { endBy(stopping); await new Promise(() => {}); }
  const found = strayed(file, home, ghLog);
  for (const line of found) console.error(line);
  if (code !== 0 || found.length) { remove(); process.exit(1); }
}
remove();
