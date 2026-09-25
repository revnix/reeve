// Temporary folders for a test file, each one removed when the process exits.
//
// A test that makes a folder under the system temp directory and never removes
// it leaves it there for good. One run of the suite left 367 of them, and a day
// of runs filled WSL's in-memory /tmp (#204). A folder made here is removed
// however the test ends: by finishing, by process.exit with a failure, by an
// uncaught error, or by SIGINT or SIGTERM.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = [];
const removeAll = () => {
  for (const dir of made.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone, or busy: nothing more to do at exit */ }
  }
};
process.on("exit", removeAll);
// A signal ends the process without running exit listeners: Ctrl-C, or a
// runner stopping a test that hangs. The folders are removed, and then the
// process ends by the same signal, so whatever sent it sees why it stopped.
// A test file that listens for the signal itself decides how it ends.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    removeAll();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  });
}

/** A new folder under the temp directory, named from `prefix`, removed when the process exits. */
export function tempDir(prefix = "reeve-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
