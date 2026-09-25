// A stop request ends the daemon's sleep between ticks (#155).
//
// The daemon checked for a stop only after sleeping out the whole interval, 90
// seconds by default. systemd gives a service 90 seconds to exit, so a stop that
// arrived during the sleep, plus the rest of any tick in progress, ran past it:
// the daemon was killed, the unit recorded as failed, and `systemctl stop` hung
// until then. This test starts the real daemon from a scratch home, halted so each
// tick returns at once, with a ten-minute interval. Once it is asleep it gets
// SIGTERM, and must exit cleanly within seconds, not minutes.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import { statePathFor } from "../src/paths.mjs";
import { withDefaults } from "../src/profile/schema.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const NWO = "acme/widget";
const home = mkdtempSync(join(tmpdir(), "reeve-stop-"));
let child = null;
try {
  const db = statePathFor(home, NWO);
  mkdirSync(dirname(db), { recursive: true });
  const store = open(db); store.close?.();
  mkdirSync(join(home, "profiles", "acme"), { recursive: true });
  writeFileSync(join(home, "profiles", "acme", "widget.json"), JSON.stringify(withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: NWO, defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" },
    state: { mode: "in-repo" }, units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] })));
  writeFileSync(join(home, "HALT"), "");   // every tick returns at once, and nothing reaches GitHub

  child = spawn(process.execPath, [join(ROOT, "bin", "reeve"), "run", NWO, "--interval", "600"],
    { cwd: home, env: { ...process.env, REEVE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  const exited = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
  const within = (ms, p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

  const asleep = await within(30_000, (async () => {
    while (!/halted — sleeping/.test(out)) await new Promise((r) => setTimeout(r, 100));
    return true;
  })());
  check(asleep === true, "control: the daemon finished a tick and went to sleep for its interval", out.slice(-400));

  const sent = Date.now();
  child.kill("SIGTERM");
  const end = await within(20_000, exited);
  const took = Date.now() - sent;
  check(end !== null && end.code === 0 && took < 15_000 && /daemon stopped/.test(out),
    "a stop request ends the sleep between ticks, and the daemon exits cleanly at once",
    end === null ? "still running 20 s after SIGTERM, asleep for the rest of its interval" : `exit ${JSON.stringify(end)} after ${took} ms`);
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  rmSync(home, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
