// A process's identity must not depend on the caller's timezone (#154).
//
// Reeve tells a live process from a stranger that reused its pid by the pid's
// start time, `ps -o lstart=`. ps prints that time in the caller's timezone, so a
// CLI running in another timezone read a different token for the same live
// daemon, called it dead, and suggested --takeover. These tests read the token
// from child processes that run under different timezones, and compare.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readStart } from "../src/supervisor.mjs";

const SUPERVISOR = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "supervisor.mjs")).href;
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// What a process running under `tz` reads for `pid`, and whether it takes
// `stored` to be the same process.
function readAs(tz, pid, stored = null) {
  const script = `import { readStart, isSameProcess } from ${JSON.stringify(SUPERVISOR)};
    const pid = Number(process.argv[1]), stored = process.argv[2] ?? null;
    console.log(JSON.stringify({ token: readStart(pid), same: stored === null ? null : isSameProcess(pid, stored) }));`;
  const args = ["--input-type=module", "-e", script, String(pid), ...(stored === null ? [] : [stored])];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, TZ: tz } }));
}

const me = process.pid;
const utc = readAs("UTC", me), karachi = readAs("Asia/Karachi", me), newYork = readAs("America/New_York", me);
check(typeof utc.token === "string" && utc.token.length > 0, "control: a live process has a token", JSON.stringify(utc));
check(utc.token === karachi.token && utc.token === newYork.token,
  "a process's identity is the same in every timezone", JSON.stringify({ utc, karachi, newYork }));

// Read from another timezone, the token is still the start time in UTC, and
// says so.
const startedAt = Date.now() - process.uptime() * 1000;
const parsed = Date.parse(karachi.token);
check(Number.isFinite(parsed) && Math.abs(parsed - startedAt) < 3000 && karachi.token.endsWith(" UTC"),
  "the token is the start time in UTC, even when read from another timezone",
  `read ${karachi.token}; started ${new Date(startedAt).toISOString()}`);

// A token recorded before the pin is what ps printed in the recorder's own
// timezone. After an upgrade it must still identify its process, or every live
// daemon and worker would look dead at once.
const before = execFileSync("ps", ["-o", "lstart=", "-p", String(me)],
  { encoding: "utf8", env: { ...process.env, TZ: "Asia/Karachi" } }).trim();
check(before !== utc.token, "control: a token from before the pin differs from the pinned one", `${before} / ${utc.token}`);
check(readAs("Asia/Karachi", me, before).same === true,
  "a token recorded before the pin still identifies its process", before);
// The recorder's timezone was never stored, and it needn't match the reader's.
const beforeInNewYork = execFileSync("ps", ["-o", "lstart=", "-p", String(me)],
  { encoding: "utf8", env: { ...process.env, TZ: "America/New_York" } }).trim();
check(readAs("Asia/Karachi", me, beforeInNewYork).same === true && readAs("UTC", me, beforeInNewYork).same === true,
  "a token recorded before the pin, in another timezone, still identifies its process", beforeInNewYork);

// lstart's format, for building tokens a stranger could have left.
const LSTART = (ms) => {
  const d = new Date(ms), p2 = (n) => String(n).padStart(2, "0");
  return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ` +
    `${String(d.getUTCDate()).padStart(2, " ")} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
};
const trueStart = Date.parse(utc.token);
// An old token must be off by a real timezone's offset, to the second.
const offByOddAmount = LSTART(trueStart + (2 * 3600 + 17 * 60 + 13) * 1000);
check(readAs("Asia/Karachi", me, offByOddAmount).same === false,
  "an old token off by anything but a real timezone's offset names a different process", offByOddAmount);
// A current token carries " UTC" and must match exactly. Five hours off is a
// real offset, and still a different process.
const currentButShifted = `${LSTART(trueStart + 5 * 3600 * 1000)} UTC`;
check(readAs("Asia/Karachi", me, currentButShifted).same === false,
  "a current token that differs names a different process, whatever the difference", currentButShifted);
check(readAs("Asia/Karachi", me, "Thu Jan  1 00:00:00 1970").same === false,
  "control: a stale token is not the same process");
check(readStart(999999) === null, "control: a pid that isn't running has no token");

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
