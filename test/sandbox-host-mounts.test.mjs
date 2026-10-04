import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { sandboxFor } from "../src/sandbox.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PLAIN = "/dev/sdc / ext4 rw,relatime 0 0\nC:\\134 /mnt/c 9p rw,aname=drvfs;path=C:\\ 0 0\n";
const DOCKER = PLAIN + "C:\\134 /Docker/host 9p rw,aname=drvfs;path=C:\\ 0 0\n";

test("the host-path tests pass with Docker Desktop and without, keeping its drive denied to both readers", { skip: process.platform !== "linux" && "Linux only" }, () => {
  const settings = sandboxFor({ profile: { units: [] }, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: "/tmp/t", mounts: DOCKER }).settings;
  assert.ok(settings.sandbox.filesystem.denyRead.includes("/Docker/host"), "the shell must not read the Docker Desktop drive");
  assert.ok(settings.permissions.deny.includes("Read(//Docker/host/**)"), "the Read tool must not read the Docker Desktop drive");

  const preload = join(tempDir("sandbox-host-mounts-"), "mounts.mjs");
  for (const [host, mounts] of [["plain WSL", PLAIN], ["Docker Desktop", DOCKER]]) {
    // Only the host's mount-table read is replaced. The sandbox tests still run
    // through the offline runner with their own home and temporary directories.
    writeFileSync(preload, `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const read = fs.readFileSync;
fs.readFileSync = function(path, options) {
  if (String(path) !== "/proc/mounts") return read.call(this, path, options);
  const mounts = ${JSON.stringify(mounts)};
  return (typeof options === "string" ? options : options?.encoding) ? mounts : Buffer.from(mounts);
};
syncBuiltinESMExports();
`);
    const ran = spawnSync(process.execPath, ["scripts/test.mjs", "test/sandbox.test.mjs"], {
      cwd: ROOT, encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}` },
    });
    assert.equal(ran.status, 0, `${host}: ${ran.stdout}\n${ran.stderr}`);
  }
});
