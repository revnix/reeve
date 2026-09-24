// The platform module (#155): the mechanisms that differ between operating
// systems, each checked on any host by passing the module its own `exec`,
// `spawn` and `os`.
//
// Each rule here guards a defect that is easy to reintroduce: Linux read a
// guessed 10 cores because macOS sysctl keys don't exist there; a keep-awake
// lock that outlives its daemon keeps a machine awake for good; a clone probe
// that always succeeds reports copy-on-write savings that never happen; and a
// notification title that starts with a dash would be read as an option.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformFor } from "../src/platform.mjs";
import { capacity } from "../src/supervisor.mjs";
import { canCloneFiles } from "../src/checkout.mjs";
import { postViaNotifySend, desktopSenderFor } from "../src/notify.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const fakeOs = (load1, cores) => ({ loadavg: () => [load1, 0, 0], availableParallelism: () => cores });

// ── load and cores ────────────────────────────────────────────────────────────
{
  const linux = platformFor("linux", { os: fakeOs(1.5, 12) });
  const lc = linux.loadAndCores();
  check(lc.load1 === 1.5 && lc.cores === 12,
    "on Linux, load and cores come from the host, not a guess", JSON.stringify(lc));
  const cap = capacity({ maxWorkers: 5, hardCeiling: 6, running: 0, host: platformFor("linux", { os: fakeOs(1, 4) }) });
  check(cap.allowed === 2 && cap.perfCores === 4,
    "control: capacity is computed from the host's cores and load", JSON.stringify(cap));

  const sysctl = (cmd, args) => {
    if (cmd !== "sysctl") throw new Error(`unexpected ${cmd}`);
    return args[1] === "vm.loadavg" ? "{ 2.50 1.00 0.50 }\n" : "10\n";
  };
  const mac = platformFor("darwin", { exec: sysctl, os: fakeOs(9, 99) }).loadAndCores();
  check(mac.load1 === 2.5 && mac.cores === 10, "control: on macOS, load and performance cores still come from sysctl", JSON.stringify(mac));
  const noSysctl = platformFor("darwin", { exec: () => { throw new Error("sysctl: unknown oid"); }, os: fakeOs(0.5, 8) }).loadAndCores();
  check(noSysctl.load1 === 0.5 && noSysctl.cores === 8,
    "control: on macOS, an unreadable sysctl falls back to the host's own figures", JSON.stringify(noSysctl));
}

// ── keeping the machine awake ─────────────────────────────────────────────────
{
  const spawned = [], probed = [];
  const spawn = (cmd, args) => { spawned.push([cmd, ...args]); return 4242; };
  const granted = (cmd, args) => { probed.push([cmd, ...args]); return ""; };
  const awake = platformFor("linux", { exec: granted, spawn }).stayAwake(777);
  const argv = spawned[0] ?? [];
  check(awake.pid === 4242 && awake.via === "systemd-inhibit" && argv[0] === "systemd-inhibit",
    "control: on Linux, the machine is kept awake by systemd-inhibit", JSON.stringify(argv));
  check(argv.includes("tail") && argv.includes("--pid=777"),
    "on Linux, the keep-awake lock ends when the daemon does", JSON.stringify(argv));
  check(argv.includes("--what=idle") && !argv.some((a) => /^--what=.*sleep/.test(a)),
    "on Linux, the lock prevents idle sleep only, as caffeinate -i does", JSON.stringify(argv));
  check(probed[0]?.at(-1) === "true", "control: the lock is taken once before the daemon's lock is held", JSON.stringify(probed));

  // Measured on WSL2: logind refuses a user service a lock that blocks sleep.
  // The refusal must be reported, not hidden behind the pid of a process that
  // had already exited.
  spawned.length = 0;
  const refused = platformFor("linux", {
    exec: () => { throw Object.assign(new Error("Command failed"), { stderr: "Failed to inhibit: Access denied as the requested operation requires interactive authentication.\n" }); },
    spawn,
  }).stayAwake(777);
  check(refused.pid === null && /Access denied/.test(refused.why ?? "") && spawned.length === 0,
    "on Linux, a refused keep-awake lock is reported, not claimed", JSON.stringify(refused));

  spawned.length = 0;
  platformFor("darwin", { spawn }).stayAwake(777);
  check(JSON.stringify(spawned[0]) === JSON.stringify(["caffeinate", "-i", "-w", "777"]),
    "control: on macOS, caffeinate -w still ties the lock to the daemon", JSON.stringify(spawned[0]));

  const none = platformFor("win32", { spawn: () => { throw new Error("should not spawn"); }, os: fakeOs(0, 4) });
  check(none.stayAwake(777).pid === null && none.desktopNotifier === null && none.cloneProbeArgs === null,
    "control: a host with no implementation keeps no lock, sends nothing and clones nothing");
}

// ── copy-on-write is reported only where the filesystem can clone ─────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-platform-"));
  try {
    // Ground truth, measured directly: can this directory's filesystem clone?
    const a = join(dir, "a"), b = join(dir, "b");
    writeFileSync(a, "x\n");
    let truth;
    try { execFileSync("cp", ["--reflink=always", a, b], { stdio: "ignore" }); truth = true; } catch { truth = false; }
    rmSync(b, { force: true });
    const reported = canCloneFiles(dir, platformFor("linux"));
    check(reported === truth, "cloning is reported exactly when the filesystem can clone",
      `reported=${reported} measured=${truth}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── desktop notifications ─────────────────────────────────────────────────────
{
  const calls = [];
  const exec = (cmd, args) => { calls.push([cmd, ...args]); return ""; };
  const title = "-x; rm -rf ~", body = "a reviewer's text with 'quotes'";
  const r = postViaNotifySend({ title, body }, exec);
  const argv = calls[0] ?? [];
  check(r.ok && argv[0] === "notify-send" && argv.at(-2) === title && argv.at(-1) === body,
    "control: the title and body are passed to notify-send as their own arguments", JSON.stringify(argv));
  check(argv.indexOf("--") >= 0 && argv.indexOf("--") < argv.indexOf(title),
    "a title that starts with a dash is passed as text, not read as an option", JSON.stringify(argv));
  const missing = postViaNotifySend({ title: "t", body: "b" }, () => { throw new Error("spawnSync notify-send ENOENT"); });
  check(missing.ok === false && /ENOENT/.test(missing.why), "control: a host without notify-send declines with the reason", JSON.stringify(missing));

  check(desktopSenderFor(platformFor("linux")) === postViaNotifySend, "control: Linux sends with notify-send");
  check(desktopSenderFor(platformFor("darwin")).name === "postViaOsascript", "control: macOS still sends with osascript");
  const declined = desktopSenderFor(platformFor("win32", { os: fakeOs(0, 1) }))({ title: "t", body: "b" });
  check(declined.ok === false && /no desktop notifier/.test(declined.why), "control: a host without a notifier declines with a reason", JSON.stringify(declined));
}

// ── the systemd user unit ─────────────────────────────────────────────────────
{
  const unit = readFileSync(new URL("../deploy/reeve.service", import.meta.url), "utf8");
  const exec = (unit.match(/^ExecStart=(.*)$/m) ?? [])[1] ?? "";
  check(/^(%h|\/)\S*\/node \S+\/bin\/reeve run [\w.-]+\/[\w.-]+$/.test(exec),
    "the service names an absolute node and states the repository it watches", exec);
  check(!/--(enforce|execute)\b/.test(exec), "control: the service starts in shadow mode and dispatches nothing", exec);
  check(/^Restart=always$/m.test(unit) && /^WantedBy=default\.target$/m.test(unit),
    "control: the service restarts after any exit and starts with the user's session");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
