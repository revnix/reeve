// The temp helper's watcher (test/fixtures/temp.mjs, #223). It reads the names
// of the folders its test made, one per line, and once its stdin ends, which it
// does when the test's end of the pipe closes, however the test ended, it
// removes them. A test killed outright, or stopped by a signal, runs no exit
// listener of its own, so this is what cleans up after it.
import { rmSync } from "node:fs";

let text = "";
const removeAll = () => {
  for (const dir of text.split("\n").filter(Boolean)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone, or busy: nothing more to do */ }
  }
};
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { text += chunk; });
process.stdin.on("end", removeAll);
process.stdin.on("error", removeAll);
