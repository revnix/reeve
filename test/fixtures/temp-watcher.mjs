// The temp helper's watcher (test/fixtures/temp.mjs, #223). It is given the
// folder its test makes all of its folders in, before that folder exists
// (#231). Once its stdin ends, which it does when the test's end of the pipe
// closes, however the test ended, it removes that folder. A test killed
// outright, or stopped by a signal, runs no exit listener of its own, so this is
// what cleans up after it.
import { rmSync } from "node:fs";

const dir = process.argv[2];
const removeAll = () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone, or busy: nothing more to do */ }
};
process.stdin.resume();
process.stdin.on("end", removeAll);
process.stdin.on("error", removeAll);
