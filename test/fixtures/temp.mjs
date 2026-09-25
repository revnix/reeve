// Temporary folders for a test file, each one removed when the process exits.
//
// A test that makes a folder under the system temp directory and never removes
// it leaves it there for good. One run of the suite left 367 of them, and a day
// of runs filled WSL's in-memory /tmp (#204). A folder made here is removed at
// exit however the test ends: by finishing, by process.exit with a failure,
// or by an uncaught error.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made = [];
process.on("exit", () => {
  for (const dir of made) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone, or busy: nothing more to do at exit */ }
  }
});

/** A new folder under the temp directory, named from `prefix`, removed when the process exits. */
export function tempDir(prefix = "reeve-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
