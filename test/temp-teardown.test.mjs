// A test file removes the temporary folders it makes (#204).
//
// test/fixtures/temp.mjs hands out folders under the system temp directory and
// removes them when the process exits. Each case here runs a child process with
// TMPDIR set to an empty folder of its own, has it make folders through the
// helper and end in one of the ways a test file ends, and then looks at what's
// left in that folder.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const helper = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "temp.mjs");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// What a child that makes two folders, one with a file in it, leaves behind
// once it ends as `ending` says. The helper is imported by its URL, since on
// Windows a path's drive letter would read as a URL's scheme, and the temp
// folder is set in TEMP and TMP too, which Windows reads instead of TMPDIR.
const leftBy = (ending) => {
  const tmp = mkdtempSync(join(tmpdir(), "reeve-teardown-"));
  try {
    const script = `import { writeFileSync } from "node:fs"; import { join } from "node:path";
      const { tempDir } = await import(${JSON.stringify(pathToFileURL(helper).href)});
      const a = tempDir("reeve-a-"); tempDir("reeve-b-"); writeFileSync(join(a, "s.db"), "x");
      ${ending}`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script],
      { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, encoding: "utf8", timeout: 30_000 });
    return { status: r.status, signal: r.signal, left: readdirSync(tmp), stderr: r.stderr.slice(0, 300) };
  } finally { rmSync(tmp, { recursive: true, force: true }); }
};

const finished = leftBy("");
const failed = leftBy("process.exit(1);");
const threw = leftBy('throw new Error("boom");');
check(finished.status === 0 && finished.left.length === 0, "a test file's temporary folders are gone once it finishes", JSON.stringify(finished));
check(failed.status === 1 && failed.left.length === 0 && threw.status !== 0 && threw.left.length === 0,
  "and once it exits with a failure, or on an uncaught error", JSON.stringify({ failed, threw }));

// A signal keeps its default action, which ends a test at once, even one busy
// in synchronous code, where a JavaScript listener would never run: a listener
// switches the default off, and Node runs it only between tasks, so a stopped
// test ran on and then exited 0 (#220). No exit listener runs then, or when a
// test is killed outright, so the helper's watcher removes the folders once the
// test is gone (#223). Windows has no signals to send: there, process.kill ends
// a process outright.
// `group` sends the signal to the test's whole process group, as Ctrl-C at a
// terminal does.
const stoppedWhileBusy = (sig, { group = false } = {}) => new Promise((resolve) => {
  const tmp = mkdtempSync(join(tmpdir(), "reeve-teardown-"));
  const script = `const { tempDir } = await import(${JSON.stringify(pathToFileURL(helper).href)});
    tempDir("reeve-a-"); process.stdout.write("ready\\n");
    const end = Date.now() + 20_000; while (Date.now() < end) {}`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script],
    { env: { ...process.env, TMPDIR: tmp, TEMP: tmp, TMP: tmp }, stdio: ["ignore", "pipe", "ignore"], detached: group });
  let sentAt = null;
  child.stdout.on("data", (d) => {
    if (sentAt !== null || !String(d).includes("ready")) return;
    sentAt = Date.now();
    if (group) process.kill(-child.pid, sig); else child.kill(sig);
  });
  child.on("exit", async (status, signal) => {
    const ms = sentAt === null ? null : Date.now() - sentAt;
    // The watcher works once the test is gone, so give it a moment.
    for (let n = 0; n < 30 && readdirSync(tmp).length; n++) await new Promise((r) => setTimeout(r, 100));
    const left = readdirSync(tmp);
    rmSync(tmp, { recursive: true, force: true });
    resolve({ sig, status, signal, ms, left });
  });
});
if (process.platform !== "win32") {
  const stopped = [await stoppedWhileBusy("SIGTERM"), await stoppedWhileBusy("SIGINT")];
  check(stopped.every(({ sig, signal, ms }) => signal === sig && ms !== null && ms < 5_000),
    "a test busy in synchronous code is ended at once by SIGTERM or SIGINT, and by that signal", JSON.stringify(stopped));
  const killed = await stoppedWhileBusy("SIGKILL");
  const interrupted = await stoppedWhileBusy("SIGINT", { group: true });
  check([...stopped, killed, interrupted].every(({ left }) => left.length === 0),
    "and its folders are gone once it has ended, by a signal, by Ctrl-C to its group, or killed outright, with no suite runner",
    JSON.stringify([...stopped, killed, interrupted].map(({ sig, left }) => ({ sig, left }))));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
