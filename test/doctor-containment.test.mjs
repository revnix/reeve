// R-14 and R-15 report the two facts the daemon's dispatch refusal rests on,
// from the same sources: the persisted canary result and the keychain probe.
// Absent is UNKNOWN, never OK; a held credential is BROKEN with the fix named.
import { checkCanary, checkKeychain, runDoctor } from "../src/doctor.mjs";
import { writeCanaryState } from "../src/canary.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const root = mkdtempSync(join(tmpdir(), "reeve-doctor-cont-"));

// ── R-14 ─────────────────────────────────────────────────────────────────────
{
  const c = checkCanary("o/r", { stateDir: null });
  check(c.id === "R-14" && c.level === "UNKNOWN", "no state dir: UNKNOWN", JSON.stringify(c));
}
{
  const c = checkCanary("o/r", { stateDir: root });
  check(c.level === "UNKNOWN" && /no canary has been recorded/.test(c.lines[0]), "no recorded canary: UNKNOWN, and it says dispatch is refused meanwhile", c.lines.join(" | "));
}
{
  writeCanaryState(root, "o/r", { id: "abc123", cliVersion: "2.1.237", ok: true, why: null, at: 1_000_000 });
  const c = checkCanary("o/r", { stateDir: root, now: () => 1_000_000 + 5 * 60_000 });
  check(c.level === "OK" && /abc123 passed 5 min ago under 2\.1\.237/.test(c.lines[0]), "a passing canary is OK with id, age and CLI", c.lines.join(" | "));
}
{
  writeCanaryState(root, "o/r", { id: "abc123", cliVersion: "2.1.237", ok: false, why: "wrote outside the worktree", at: 1_000_000 });
  const c = checkCanary("o/r", { stateDir: root, now: () => 1_000_000 + 30_000 });
  check(c.level === "BROKEN" && /FAILED under a minute ago/.test(c.lines[0]) && /wrote outside/.test(c.lines[0]), "a failed canary is BROKEN with its reason", c.lines.join(" | "));
}
{
  const c = checkCanary("o/r", { stateDir: root, read: () => ({ ok: "yes", id: "x" }) });
  check(c.level === "BROKEN", "a state whose ok is not exactly true is not a pass", JSON.stringify(c));
}

// ── R-15 ─────────────────────────────────────────────────────────────────────
{
  const c = checkKeychain({ probe: () => ({ measured: true, items: [], why: null }) });
  check(c.id === "R-15" && c.level === "OK", "an empty keychain (of GitHub items) is OK", JSON.stringify(c));
}
{
  const c = checkKeychain({ probe: () => ({ measured: true, items: ["generic password gh:github.com (gh keyring)"], why: "holds" }) });
  check(c.level === "BROKEN" && /gh keyring/.test(c.lines[0]) && /--insecure-storage/.test(c.lines.join(" ")) && /dedicated user/.test(c.lines.join(" ")),
    "a held credential is BROKEN and both closures are named", c.lines.join(" | "));
}
{
  const c = checkKeychain({ probe: () => ({ measured: false, items: [], why: "security exited 1" }) });
  check(c.level === "UNKNOWN" && /unmeasured/.test(c.lines[0]), "an unmeasured probe is UNKNOWN, never OK", c.lines.join(" | "));
}

// ── in the driver ────────────────────────────────────────────────────────────
{
  const r = runDoctor({ nwo: "o/r", profile: {}, stateDir: root, keychainIo: { probe: () => ({ measured: true, items: [], why: null }) },
                        baselineIo: { fixturePath: join(root, "none.json") } });
  const ids = r.checks.map(c => c.id);
  check(ids.includes("R-14") && ids.includes("R-15"), "both checks run in the driver", ids.join(","));
  check(r.verdict === "BROKEN" && r.checks.find(c => c.id === "R-14").level === "BROKEN", "and a failed canary makes the verdict BROKEN", r.verdict);
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
