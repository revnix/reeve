// Temporary folders for a test file, each one removed when the process exits.
//
// A test that makes a folder under the system temp directory and never removes
// it leaves it there for good. One run of the suite left 367 of them, and a day
// of runs filled WSL's in-memory /tmp (#204). A folder made here is removed at
// exit however the test ends: by finishing, by process.exit with a failure,
// or by an uncaught error.
//
// Not by a listener for a signal. A listener for SIGINT or SIGTERM switches the
// signal's default action off, and Node runs it only between tasks, so a test
// busy in synchronous code would run on, and then exit 0, rather than stop
// (#220). A signal ends a test at once, and runs no exit listener; nor does
// SIGKILL. So the first folder starts a watcher, a small process of its own
// that is told each folder's name and removes them all once this process is
// gone, however it went (#223). The suite's runner, scripts/test.mjs, removes
// its run's folder too.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const made = [];
process.on("exit", () => {
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone, or busy: nothing more to do at exit */ }
  }
});

// The watcher reads the folders' names on its stdin, and the pipe closes when
// this process ends, which is its cue. Neither the pipe nor the watcher keeps
// this process alive, and the watcher is in a group of its own, so Ctrl-C at a
// terminal doesn't stop it before it has done its work.
let watcher = null;
const watch = (dir) => {
  if (!watcher) {
    watcher = spawn(process.execPath, [fileURLToPath(new URL("temp-watcher.mjs", import.meta.url))],
      { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    watcher.on("error", () => { /* no watcher: the exit listener still runs */ });
    watcher.stdin.on("error", () => { /* the watcher went early: the exit listener still runs */ });
    watcher.unref();
    watcher.stdin.unref();
  }
  watcher.stdin.write(`${dir}\n`);
};

/** A new folder under the temp directory, named from `prefix`, removed when the process exits. */
export function tempDir(prefix = "reeve-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  watch(dir);
  return dir;
}
