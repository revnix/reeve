// Every path the canary script names is one shell word, whatever it holds (#156).
//
// The script is run by sh, and a path in double quotes still has `$(...)`,
// backticks and `$VAR` expanded. The drive file is found by `find`, so its name
// is anyone's: a copy that expanded a different path would fail, and a failed
// copy reads as a deny that held, so the canary could pass while the deny was
// open. Reeve's own paths come from its configuration, which can hold `$` too.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canaryScript } from "../src/canary.mjs";
import { tempDir } from "./fixtures/temp.mjs";

// A name with every kind of shell syntax a filename can hold: a command
// substitution each way, a variable, and a single quote.
const HOSTILE = "x$(touch ran)y`touch ran2`$HOME'q.txt";

// The script's one line for `key`, run on its own in `cwd`.
const runLine = (script, key, cwd) => {
  const line = script.split("\n").find((l) => l.includes(`rec ${key} `));
  assert.ok(line, `no line for ${key}`);
  execFileSync("sh", ["-c", `rec() { :; }; ${line}`], { cwd });
};

test("a drive file whose name holds shell syntax is copied as named, and nothing in its name runs", () => {
  const drive = tempDir("cq-drive-");
  const cwd = tempDir("cq-cwd-");
  writeFileSync(join(drive, HOSTILE), "from the drive\n");
  const s = canaryScript({ tmpDir: "/t", outsideDir: "/o", decoyPath: "/h/.reeve/d.txt", platform: "linux",
                           linux: { node: process.execPath, mntFile: join(drive, HOSTILE), windowsExe: null, bus: null, skipped: {} } });
  runLine(s, "mnt_read", cwd);
  assert.equal(existsSync(join(cwd, "ran")) || existsSync(join(cwd, "ran2")), false, "a command in the file's name ran");
  assert.equal(readFileSync(join(cwd, "mnt-copy"), "utf8"), "from the drive\n", "the file wasn't copied as named");
});

test("reeve's own paths in the script are one word each too: the decoy, its link, and the file decoy and its control", () => {
  const home = tempDir("cq-home-");
  const cwd = tempDir("cq-cwd2-");
  const at = (n) => join(home, `${n}-${HOSTILE}`);
  for (const n of ["decoy", "filedecoy", "filecontrol"]) writeFileSync(at(n), `${n}\n`);
  const s = canaryScript({ tmpDir: "/t", outsideDir: "/o", decoyPath: at("decoy"), fileDecoyPath: at("filedecoy"), fileControlPath: at("filecontrol"), platform: "linux" });
  for (const [key, copy] of [["decoy", "decoy-copy"], ["filedecoy", "filedecoy-copy"], ["filecontrol", "filecontrol-copy"], ["symlink", "decoy-copy2"]]) {
    runLine(s, key, cwd);
    assert.ok(existsSync(join(cwd, copy)), `${key}: the path wasn't read as named`);
  }
  assert.equal(existsSync(join(cwd, "ran")) || existsSync(join(cwd, "ran2")), false, "a command in a path ran");
});
