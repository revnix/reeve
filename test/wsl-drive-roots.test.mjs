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

test("the canary finds a drive file whose name holds a newline whole, never a prefix of it", async () => {
  // Split at the newline, the probe would copy a prefix that isn't there, and
  // the failed copy would read as a deny that held.
  const drive = realpathSync(tempDir("wd-newline-"));
  const name = "first line\nsecond line.txt";
  writeFileSync(join(drive, name), "readable\n");
  const t = await linuxProbeTargets({ mounts: "", driveRoots: [drive], searchRoots: [drive], mntCandidates: [], uid: -1 });
  assert.equal(t.mntFile, join(drive, name));
});

test("a search of the drives that couldn't run isn't read as a drive with nothing to read", async () => {
  // find missing, erroring out or out of time answers nothing, which is not
  // proof that nothing is readable: the probe would be skipped, and the canary
  // could pass with the deny open.
  const empty = realpathSync(tempDir("wd-empty-"));
  await assert.rejects(linuxProbeTargets({ mounts: "", driveRoots: [empty], searchRoots: [empty], mntCandidates: [], uid: -1, findBin: "/nonexistent/find" }),
                       /couldn't be searched/);
  // The control: a search that ran and found nothing skips the probe, and says why.
  const t = await linuxProbeTargets({ mounts: "", driveRoots: [empty], searchRoots: [empty], mntCandidates: [], uid: -1 });
  assert.equal(t.mntFile, null);
  assert.match(t.skipped.mnt ?? "", /readable/);
});

test("the canary finds a readable file on a drive however deep it is", async () => {
  // A data drive with nothing readable near its root, and a file five folders
  // down. A search that stopped at three would read the drive as empty, and
  // skip the probe of its deny.
  const drive = realpathSync(tempDir("wd-deep-"));
  const deep = join(drive, "a", "b", "c", "d", "e");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "notes.txt"), "readable\n");
  const t = await linuxProbeTargets({ mounts: "", driveRoots: [drive], searchRoots: [drive], mntCandidates: [], uid: -1 });
  assert.equal(t.mntFile, join(deep, "notes.txt"));
});

// A find that answers as a real one would in trouble: what it prints, and how it exits.
// A path found is printed NUL-ended, as -print0 does.
const fakeFind = (prefix, { stderr = "", found = null, status = 1, sleep = 0 } = {}) => {
  const dir = tempDir(prefix);
  const bin = join(dir, "find");
  const q = (x) => `'${String(x).replace(/'/g, "'\\''")}'`;
  writeFileSync(bin, `#!/bin/sh\n${sleep ? `sleep ${sleep}\n` : ""}${found ? `printf '%s\\0' ${q(found)}\n` : ""}${stderr ? `printf '%s\\n' ${q(stderr)} >&2\n` : ""}exit ${status}\n`, { mode: 0o755 });
  return bin;
};

test("a search that ends in an error other than a folder it can't read isn't read as an empty drive", async () => {
  // GNU find exits 1 for an I/O error as for a folder it can't read, with no
  // error for Node to see. Only the second leaves the drive measured as empty:
  // the worker can't read that folder either.
  const empty = realpathSync(tempDir("wd-ioerr-"));
  const at = (findBin) => linuxProbeTargets({ mounts: "", driveRoots: [empty], searchRoots: [empty], mntCandidates: [], uid: -1, findBin });
  await assert.rejects(at(fakeFind("wd-find-io-", { stderr: `find: '${empty}/x': Input/output error` })), /couldn't be searched/);
  const t = await at(fakeFind("wd-find-perm-", { stderr: `find: '${empty}/x': Permission denied` }));
  assert.equal(t.mntFile, null, "control: a folder it can't read leaves the drive measured, and empty");
});

test("the search of the drives doesn't hold up the daemon while it runs", async () => {
  // A slow drive can take the whole timeout, and the daemon's timers wait on it.
  const drive = realpathSync(tempDir("wd-slow-"));
  writeFileSync(join(drive, "f.txt"), "readable\n");
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 50);
  try {
    const t = await linuxProbeTargets({ mounts: "", driveRoots: [drive], searchRoots: [drive], mntCandidates: [], uid: -1,
                                        findBin: fakeFind("wd-find-slow-", { found: join(drive, "f.txt"), status: 0, sleep: 1 }) });
    assert.equal(t.mntFile, join(drive, "f.txt"), "control: it found the file");
  } finally { clearInterval(timer); }
  assert.ok(ticks >= 5, `the daemon's timers ran ${ticks} times in a one-second search`);
});

test("the interop control runs with the worker's environment, so a binary that won't launch there is skipped, not read as held", async () => {
  // Where launching a Windows binary needs WSL_INTEROP and a worker's
  // environment lacks it, the sandboxed probe fails for want of it. The control
  // must fail the same way, or that failure reads as the sandbox holding.
  const c = realpathSync(tempDir("wd-env-c-"));
  const sys = join(c, "Windows", "System32");
  mkdirSync(sys, { recursive: true });
  writeFileSync(join(sys, "cmd.exe"), "#!/bin/sh\n[ -n \"$REEVE_TEST_INTEROP\" ] && exit 0\nexit 1\n", { mode: 0o755 });
  const mounts = `C:\\134 ${c} 9p rw,noatime,aname=drvfs;path=C:\;uid=1000 0 0\n`;
  const saved = process.env.REEVE_TEST_INTEROP;
  process.env.REEVE_TEST_INTEROP = "1";
  try {
    const without = await linuxProbeTargets({ mounts, driveRoots: [c], uid: -1, env: { PATH: "/usr/bin:/bin" } });
    assert.equal(without.windowsExe, null, "the control ran with the daemon's environment, not the worker's");
    const withIt = await linuxProbeTargets({ mounts, driveRoots: [c], uid: -1, env: { PATH: "/usr/bin:/bin", REEVE_TEST_INTEROP: "1" } });
    assert.equal(withIt.windowsExe, join(sys, "cmd.exe"), "control: with it in the worker's environment, the binary is the probe");
  } finally { if (saved === undefined) delete process.env.REEVE_TEST_INTEROP; else process.env.REEVE_TEST_INTEROP = saved; }
});
