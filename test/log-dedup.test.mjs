// The daemon writes each line to stdout AND appends it to its log file. Under
// launchd those are the same file, because StandardOutPath names the log the
// daemon already appends to, so every line landed twice. Doubling is worse than
// noise here: the shadow week's evidence is counted from this file, and a
// doubled log makes a quiet night look twice as busy as it was.
import { log } from "../src/daemon.mjs";
import { openSync, closeSync, readFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const dir = mkdtempSync(join(tmpdir(), "reeve-log-"));
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// Positive control: with stdout somewhere else, the line must appear exactly once
// in the file. If this fails, the harness is wrong, not the code.
{
  const p = join(dir, "separate.log");
  const script =
    `import {log} from ${JSON.stringify(new URL("../src/daemon.mjs", import.meta.url).href)};` +
    `log(${JSON.stringify(p)}, "marker-separate");`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { stdio: ["ignore", "ignore", "inherit"] });
  const n = readFileSync(p, "utf8").split("\n").filter(l => l.includes("marker-separate")).length;
  check(n === 1, "control: stdout elsewhere writes the line once", `got ${n}`);
}

// The launchd shape: stdout IS the log file, exactly as StandardOutPath arranges.
{
  const p = join(dir, "same.log");
  const fd = openSync(p, "a");
  const script =
    `import {log} from ${JSON.stringify(new URL("../src/daemon.mjs", import.meta.url).href)};` +
    `log(${JSON.stringify(p)}, "marker-same");`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script],
    { stdio: ["ignore", fd, "inherit"] });
  closeSync(fd);
  const lines = readFileSync(p, "utf8").split("\n").filter(l => l.includes("marker-same"));
  check(lines.length === 1, "stdout redirected to the log file still writes the line once",
    `got ${lines.length}:\n        ` + lines.join("\n        "));
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
