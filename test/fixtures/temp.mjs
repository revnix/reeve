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
// that removes this process's folders once it is gone, however it went (#223).
// Every folder is made inside one of this process's own, whose name the
// watcher is given as it starts, before that folder exists: so a kill at any
// moment leaves nothing the watcher doesn't know of (#231). The suite's runner,
// scripts/test.mjs, removes its run's folder too.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The folder this process makes its folders in, once it has made the first.
let home = null;
process.on("exit", () => {
  if (!home) return;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* already gone, or busy: nothing more to do at exit */ }
});

// The watcher waits for its stdin to close, which it does when this process
// ends. It doesn't keep this process alive, nor does the pipe, which is never
// written to. And it is in a group of its own, so Ctrl-C at a terminal doesn't
// stop it before it has done its work.
const watch = (dir) => {
  const watcher = spawn(process.execPath, [fileURLToPath(new URL("temp-watcher.mjs", import.meta.url)), dir],
    { detached: true, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  watcher.on("error", () => { /* no watcher: the exit listener still runs */ });
  watcher.stdin.on("error", () => { /* the watcher went early: the exit listener still runs */ });
  watcher.unref();
};

/** A new folder under the temp directory, named from `prefix`, removed when the process exits. */
export function tempDir(prefix = "reeve-") {
  if (!home) {
    const dir = join(tmpdir(), `reeve-test-${process.pid}-${randomBytes(6).toString("hex")}`);
    watch(dir);
    mkdirSync(dir, { mode: 0o700 });
    home = dir;
  }
  return mkdtempSync(join(home, prefix));
}
