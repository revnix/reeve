// A test file removes the temporary folders it makes (#204).
//
// test/fixtures/temp.mjs hands out folders under the system temp directory and
// removes them when the process exits. Each case here runs a child process with
// TMPDIR set to an empty folder of its own, has it make folders through the
// helper and end in one of the ways a test file ends, and then looks at what's
// left in that folder.
import { spawnSync } from "node:child_process";
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

// A signal ends a process without its exit listeners: Ctrl-C, or a runner
// stopping a test file that hangs. The folders go all the same, and the child
// still ends by that signal, so whatever sent it sees why it stopped. Windows
// has no signals to send: there, process.kill ends a process outright.
if (process.platform !== "win32") {
  const stopped = ["SIGINT", "SIGTERM"].map((sig) => ({ sig, ...leftBy(`process.kill(process.pid, ${JSON.stringify(sig)}); setTimeout(() => {}, 20_000);`) }));
  check(stopped.every(({ sig, signal, left }) => signal === sig && left.length === 0),
    "and once SIGINT or SIGTERM stops it, which it still ends by", JSON.stringify(stopped));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
