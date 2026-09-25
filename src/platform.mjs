// platform — the mechanisms that differ between operating systems, behind one
// interface.
//
// reeve ran on macOS first. The work now happens on Linux, including WSL2, and
// native Windows comes later as another implementation here rather than a
// rewrite of every caller. `process.platform` picks the implementation; a test
// passes its own `exec`, `spawn` and `os`, so each one is checked on any host.
//
// Two mechanisms are the same on every POSIX host and stay where they are:
// process identity (`readStart` in supervisor.mjs, pinned to UTC) and killing a
// process tree (a signal to the negative process-group id).
import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import nodeOs from "node:os";

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const detach = (cmd, args) => {
  const c = nodeSpawn(cmd, args, { detached: true, stdio: "ignore" });
  c.on("error", () => {});   // a missing binary is reported by the null pid, not by a crash
  c.unref();
  return c.pid ?? null;
};

/**
 * The implementation for an operating system. `deps` replaces how commands are
 * run and how the host is read, for tests.
 */
export function platformFor(name = process.platform, { exec = run, spawn = detach, os = nodeOs } = {}) {
  if (name === "darwin") return darwin({ exec, spawn, os });
  if (name === "linux") return linux({ exec, spawn, os });
  return unsupported(name, { os });
}

/** The implementation for the host this process runs on. */
export const platform = platformFor();

function darwin({ exec, spawn, os }) {
  return {
    name: "darwin",
    service: { manager: "launchd", file: "deploy/com.revnix.reeve.plist" },

    // The performance-core count, not every core: on Apple silicon the
    // efficiency cores are slow enough that counting them over-schedules.
    loadAndCores() {
      let load1 = null, cores = null;
      try { load1 = Number(exec("sysctl", ["-n", "vm.loadavg"]).replace(/[{}]/g, "").trim().split(/\s+/)[0]); } catch { /* read below */ }
      try { cores = Number(exec("sysctl", ["-n", "hw.perflevel0.logicalcpu"]).trim()) || null; } catch { /* read below */ }
      return { load1: Number.isFinite(load1) ? load1 : os.loadavg()[0], cores: cores ?? os.availableParallelism() };
    },

    // -i prevents idle sleep and leaves the display free to sleep. -w ties the
    // assertion to the daemon's pid, so a crashed daemon can't leave the Mac
    // permanently unable to sleep.
    stayAwake(pid) {
      return { pid: spawn("caffeinate", ["-i", "-w", String(pid)]), via: "caffeinate" };
    },

    // Which desktop notifier this host has. The senders live in notify.mjs,
    // with the rule that escalation text is never parsed as a script.
    desktopNotifier: "osascript",

    // `cp -c` clones copy-on-write, and fails on anything but APFS.
    cloneProbeArgs: (from, to) => ["-c", from, to],
    copyTreeArgs: (from, to, cow) => (cow ? ["-Rc", from, to] : ["-R", from, to]),
  };
}

function linux({ exec, spawn, os }) {
  return {
    name: "linux",
    service: { manager: "systemd", file: "deploy/reeve.service" },

    loadAndCores() {
      return { load1: os.loadavg()[0], cores: os.availableParallelism() };
    },

    // An idle lock, as `caffeinate -i` is on macOS: it stops the machine
    // suspending while idle, and leaves explicit suspends alone. systemd-inhibit
    // holds it for as long as its command runs, and `tail --pid` runs exactly as
    // long as the daemon does, so a crashed daemon can't keep the machine awake.
    // On WSL2 this holds the Linux side only: Windows decides when the host sleeps.
    //
    // The lock can be refused. Measured on WSL2: a user service may take an idle
    // lock, but logind asks for interactive authentication before it lets one
    // block sleep outright. So the lock is taken once with `true` first. A
    // refusal is reported with its reason, rather than as the pid of a process
    // that had already exited.
    stayAwake(pid) {
      const lock = ["--what=idle", "--who=reeve", "--why=the reeve daemon is running", "--mode=block"];
      try { exec("systemd-inhibit", [...lock, "true"], { stdio: ["ignore", "ignore", "pipe"], timeout: 8000 }); }
      catch (e) { return { pid: null, via: null, why: String(e.stderr || e.message).trim().split("\n")[0] }; }
      return { pid: spawn("systemd-inhibit", [...lock, "tail", `--pid=${pid}`, "-f", "/dev/null"]), via: "systemd-inhibit" };
    },

    desktopNotifier: "notify-send",

    // Probe with --reflink=always, which fails where the filesystem can't clone.
    // --reflink=auto would silently fall back to a full copy, so a probe with it
    // would report cloning on every filesystem and the saving would be a guess.
    cloneProbeArgs: (from, to) => ["--reflink=always", from, to],
    copyTreeArgs: (from, to, cow) => (cow ? ["-R", "--reflink=always", from, to] : ["-R", from, to]),
  };
}

// A host with no implementation yet, such as native Windows. Nothing here
// pretends to work: it keeps no lock, sends no notification and clones nothing.
function unsupported(name, { os }) {
  return {
    name,
    service: null,
    loadAndCores: () => ({ load1: os.loadavg()[0], cores: os.availableParallelism() }),
    stayAwake: () => ({ pid: null, via: null }),
    desktopNotifier: null,
    cloneProbeArgs: null,
    copyTreeArgs: (from, to) => ["-R", from, to],
  };
}
