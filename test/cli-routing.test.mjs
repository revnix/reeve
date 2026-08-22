// The CLI's case labels share fall-through blocks, so inserting a new subcommand
// between a label and the body it belongs to silently captures every command
// above it. That is exactly what happened: `shadow` landed between
// status/statusline/dash and their shared body, and for a full day the three
// founder-facing commands all printed the shadow report and exited with its
// code. No unit test could see it -- only running the binary routes through the
// switch -- so this test runs the binary.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-cli-"));
const dbPath = join(dir, "s.db");

// A real (empty) store, created the same way every command opens one.
const { open } = await import("../src/db/ops.mjs");
open(dbPath).close();

const bin = new URL("../bin/reeve", import.meta.url).pathname;
const run = (...args) => {
  try {
    return { out: execFileSync(process.execPath, [bin, ...args, "--db", dbPath], { encoding: "utf8" }), code: 0 };
  } catch (e) {
    return { out: (e.stdout ?? "") + (e.stderr ?? ""), code: e.status };
  }
};

// Each command must reach ITS OWN body. The shadow report leaking into another
// command's output is the exact defect this file exists to refuse.
{
  const s = run("status", "o/r");
  check(/NEEDS YOU/.test(s.out), "status renders the status screen", s.out.slice(0, 120));
  check(!/review shadow/.test(s.out), "and not the shadow report", s.out.slice(0, 120));
  check(s.code === 0, "status exits 0, not shadow's not-enough-days code", `exit=${s.code}`);

  const l = run("statusline", "o/r");
  check(!/review shadow/.test(l.out) && l.out.trim().split("\n").length === 1,
    "statusline prints one line, not the shadow report", JSON.stringify(l.out.slice(0, 120)));

  const w = run("why", "o/r");
  check(/why <pr-number>/.test(w.out) && !/review shadow/.test(w.out),
    "why without a PR asks for one instead of printing the shadow report", w.out.slice(0, 120));
}

// Control: shadow itself still answers, and still holds the gate shut on an
// empty store -- routing must be fixed WITHOUT the gate accidentally opening.
{
  const sh = run("shadow", "o/r");
  check(/review shadow/.test(sh.out), "control: shadow still prints the shadow report", sh.out.slice(0, 120));
  check(sh.code === 3, "control: shadow still exits 3 with no clean days", `exit=${sh.code}`);
}

// `canary` sits immediately above the run/tick labels, which is the position
// that captured three commands the last time. It must reach its OWN body: with
// no profile it says so as itself, and it must NOT fall through into `run` and
// start the daemon. The refusal happens before any measurement, so this costs
// no model call.
{
  const c = run("canary", "o/r");
  check(/reeve canary: no profile/.test(c.out), "canary reaches its own body, not run's", c.out.slice(0, 160));
  check(!/reeve run:/.test(c.out) && !/daemon starting/.test(c.out), "and does not fall through into the daemon", c.out.slice(0, 160));
  check(c.code === 1, "and exits 1 rather than running", `exit=${c.code}`);
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
