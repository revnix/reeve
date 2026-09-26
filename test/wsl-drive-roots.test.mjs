// The Windows drives are denied wherever WSL mounts them (#156).
//
// WSL mounts the drives under /mnt by default, but `[automount] root` in
// /etc/wsl.conf moves them, and `mount -t drvfs` can put one anywhere. The mount
// table says where each one is: drvfs, or on WSL2 9p with aname=drvfs, as this
// host shows (`C:\134 /mnt/c 9p rw,...,aname=drvfs;path=C:\;...`). A drive the
// policy doesn't name would be readable to a worker's shell, and the socket
// filter doesn't stop a file read.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostEscapePaths, sandboxFor, validateSettings, windowsDriveRoots } from "../src/sandbox.mjs";
import { linuxProbeTargets } from "../src/canary.mjs";
import { cheapContainmentReasons } from "../src/containment.mjs";
import { tempDir } from "./fixtures/temp.mjs";

// A mount table with the drives outside /mnt: C: and D: under /windows as the
// automount root would put them, E: mounted by hand at a path with a space, and
// WSL's own driver store, which is 9p but not a drive.
const MOUNTS = [
  "/dev/sdc / ext4 rw,relatime 0 0",
  "drivers /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,aname=drivers;fmask=222;dmask=222 0 0",
  "C:\\134 /windows/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/windows/ 0 0",
  "D:\\134 /windows/d 9p rw,noatime,aname=drvfs;path=D:\\;uid=1000;gid=1000;symlinkroot=/windows/ 0 0",
  "E: /media/win\\040e drvfs rw,noatime,uid=1000 0 0",
  "C:\\134 /mnt/c 9p rw,noatime,aname=drvfs;path=C:\\;uid=1000 0 0",
].join("\n") + "\n";

test("the Windows drives are found in the mount table wherever WSL mounts them", () => {
  assert.deepEqual(windowsDriveRoots(MOUNTS), ["/windows/c", "/windows/d", "/media/win e", "/mnt/c"]);
  assert.deepEqual(windowsDriveRoots("/dev/sdc / ext4 rw 0 0\n"), [], "control: a host with no drives has none");
  assert.equal(windowsDriveRoots(null), null, "a table that couldn't be read is not a table with no drives");
});

test("on Linux the host's ways out include every Windows drive, not only /mnt", () => {
  const paths = hostEscapePaths({ platform: "linux", uid: 1000, mounts: MOUNTS });
  for (const p of ["/mnt", "/windows/c", "/windows/d", "/media/win e"]) assert.ok(paths.includes(p), `${p} is missing: ${JSON.stringify(paths)}`);
  assert.ok(!paths.includes("/mnt/c"), "a drive under /mnt is covered by /mnt, and listed once");
  assert.deepEqual(hostEscapePaths({ platform: "darwin", mounts: MOUNTS }), [], "control: none elsewhere");
});

test("the Linux policy denies a Windows drive outside /mnt to the shell and the Read tool, and the validator requires it", { skip: process.platform !== "linux" && "Linux only" }, () => {
  const profile = { identity: { key: "o/r", defaultBranch: "main" }, units: [] };
  const s = sandboxFor({ profile, action: "FIX_CI", worktree: "/tmp/wt", tmpDir: "/tmp/t", mounts: MOUNTS }).settings;
  assert.ok(s.sandbox.filesystem.denyRead.includes("/windows/c"), JSON.stringify(s.sandbox.filesystem.denyRead));
  assert.ok(s.permissions.deny.includes("Read(//windows/c/**)"), JSON.stringify(s.permissions.deny.filter((d) => d.includes("windows"))));
  assert.equal(validateSettings(s, { tmpDir: "/tmp/t", mounts: MOUNTS }).ok, true, "control: the policy it made validates");
  const without = structuredClone(s);
  without.sandbox.filesystem.denyRead = without.sandbox.filesystem.denyRead.filter((d) => d !== "/windows/c");
  const v = validateSettings(without, { tmpDir: "/tmp/t", mounts: MOUNTS });
  assert.equal(v.ok, false, "a policy that leaves a drive readable was accepted");
  assert.match(v.errors.join("; "), /\/windows\/c/);
});

test("the canary looks for a readable file on every Windows drive, not only under /mnt", async () => {
  const drive = realpathSync(tempDir("wd-drive-"));
  mkdirSync(join(drive, "Windows", "System32", "drivers", "etc"), { recursive: true });
  writeFileSync(join(drive, "Windows", "System32", "drivers", "etc", "hosts"), "127.0.0.1 localhost\n");
  const t = await linuxProbeTargets({ driveRoots: [drive], windowsExe: "/nonexistent/cmd.exe", uid: -1 });
  assert.equal(t.mntFile, join(drive, "Windows", "System32", "drivers", "etc", "hosts"));
});

test("containment stays open on Linux when the mount table can't be read, since the drives can't be found to deny", () => {
  const kc = { measured: true, items: [], why: null };
  const open = cheapContainmentReasons({ platform: "linux", isolated: true, keychain: kc, mounts: null });
  assert.ok(open.reasons.some((r) => /mount table/.test(r)), JSON.stringify(open.reasons));
  const ok = cheapContainmentReasons({ platform: "linux", isolated: true, keychain: kc, mounts: MOUNTS });
  assert.deepEqual(ok.reasons, [], "control: a readable table adds no reason");
});

test("on Linux a host path the distro makes a link is denied at its target, as Fedora's ostree variants make /mnt a link to /var/mnt", () => {
  const atTarget = (p) => (p === "/mnt" ? "/var/mnt" : p);
  const paths = hostEscapePaths({ platform: "linux", uid: 1000, mounts: "", atTarget });
  assert.ok(paths.includes("/var/mnt") && !paths.includes("/mnt"), JSON.stringify(paths));
});

// A drive with a planted Windows/System32/cmd.exe: a script that leaves a mark
// if anything runs it.
const plantedDrive = (prefix) => {
  const drive = realpathSync(tempDir(prefix));
  const sys = join(drive, "Windows", "System32");
  mkdirSync(sys, { recursive: true });
  const mark = join(drive, "ran");
  writeFileSync(join(sys, "cmd.exe"), `#!/bin/sh\ntouch ${JSON.stringify(mark)}\nexit 0\n`, { mode: 0o755 });
  return { drive, exe: join(sys, "cmd.exe"), mark };
};

test("the daemon runs only the system drive's cmd.exe for its interop control, never one on another drive", async () => {
  // D: is a secondary or removable volume. What's on it is anyone's, and the
  // daemon runs its control outside any sandbox.
  const d = plantedDrive("wd-planted-d-");
  const onlyD = `D:\\134 ${d.drive} 9p rw,noatime,aname=drvfs;path=D:\;uid=1000 0 0\n`;
  const t = await linuxProbeTargets({ mounts: onlyD, driveRoots: [d.drive], uid: -1 });
  assert.equal(existsSync(d.mark), false, "a cmd.exe on a secondary drive was run by the daemon");
  assert.equal(t.windowsExe, null);
  assert.match(t.skipped.interop ?? "", /system drive/);
  // The control: the system drive's own is the one it runs.
  const c = plantedDrive("wd-planted-c-");
  const withC = `C:\\134 ${c.drive} 9p rw,noatime,aname=drvfs;path=C:\;uid=1000 0 0\n` + onlyD;
  const tc = await linuxProbeTargets({ mounts: withC, driveRoots: [c.drive, d.drive], uid: -1 });
  assert.equal(tc.windowsExe, c.exe, "control: the system drive's cmd.exe is the interop control");
  assert.equal(existsSync(d.mark), false, "a cmd.exe on a secondary drive was run by the daemon");
});
