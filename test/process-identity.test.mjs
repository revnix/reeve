// A process's identity must not depend on the caller's timezone (#154).
//
// Reeve tells a live process from a stranger that reused its pid by the pid's
// start time, `ps -o lstart=`. ps prints that time in the caller's timezone, so a
// CLI running in another timezone read a different token for the same live
// daemon, called it dead, and suggested --takeover. These tests read the token
// from child processes that run under different timezones, and compare.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
// `stored` to be the same process. `env` adds to the environment, for a locale.
function readAs(tz, pid, stored = null, env = {}) {
  const script = `import { readStart, isSameProcess } from ${JSON.stringify(SUPERVISOR)};
    const pid = Number(process.argv[1]), stored = process.argv[2] ?? null;
    console.log(JSON.stringify({ token: readStart(pid), same: stored === null ? null : isSameProcess(pid, stored) }));`;
  const args = ["--input-type=module", "-e", script, String(pid), ...(stored === null ? [] : [stored])];
  return JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", env: { ...process.env, ...env, TZ: tz } }));
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
// ps accepts the fixed-offset zones, and no regional zone uses -12:00.
const beforeAtGmtMinus12 = execFileSync("ps", ["-o", "lstart=", "-p", String(me)],
  { encoding: "utf8", env: { ...process.env, TZ: "Etc/GMT+12", LC_ALL: "C" } }).trim();
check(readAs("Asia/Karachi", me, beforeAtGmtMinus12).same === true,
  "a token recorded before the pin under a fixed-offset zone, Etc/GMT+12, still identifies its process", beforeAtGmtMinus12);

// Read the way it was recorded, a token matches whatever it spells. A POSIX TZ
// string with an offset no zone uses stands in for anything the date parser
// can't account for, and needs no locale installed.
const ODD = { TZ: "XYZ+3:17", LC_ALL: "C" };
const beforeOdd = execFileSync("ps", ["-o", "lstart=", "-p", String(me)], { encoding: "utf8", env: { ...process.env, ...ODD } }).trim();
check(readAs("Asia/Karachi", me, beforeOdd).same === false,
  "control: read from another environment, a token at an offset no zone uses names nothing", beforeOdd);
check(readAs(ODD.TZ, me, beforeOdd, ODD).same === true,
  "a token recorded before the pin identifies its process to a caller in the recorder's own environment, whatever it spells", beforeOdd);

// The realistic case: a non-English locale, whose lstart no date parser reads.
// Built into a scratch directory, because most machines install only C; where
// localedef or its sources are missing, the check is skipped and says so.
{
  const locales = mkdtempSync(join(tmpdir(), "reeve-locale-"));
  try {
    try { execFileSync("localedef", ["-c", "-i", "ru_RU", "-f", "UTF-8", join(locales, "ru_RU.UTF-8")], { stdio: "ignore" }); } catch { /* judged by what it left */ }
    const name = "a token recorded before the pin in a non-English locale identifies its process to a caller with that locale";
    if (!existsSync(join(locales, "ru_RU.UTF-8"))) console.log(`SKIP  ${name} (localedef or its ru_RU sources are missing)`);
    else {
      const RU = { TZ: "Europe/Moscow", LC_ALL: "ru_RU.UTF-8", LOCPATH: locales };
      const beforeRu = execFileSync("ps", ["-o", "lstart=", "-p", String(me)], { encoding: "utf8", env: { ...process.env, ...RU } }).trim();
      check(Number.isNaN(Date.parse(`${beforeRu} UTC`)), "control: in that locale, lstart is a string no date parser reads", beforeRu);
      check(readAs(RU.TZ, me, beforeRu, RU).same === true, name, beforeRu);
    }
  } finally { rmSync(locales, { recursive: true, force: true }); }
}

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
