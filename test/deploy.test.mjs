// The launchd agent is the one artifact that runs with no human watching, so a
// mistake in it is silent for a whole night. Plist syntax validating proves
// nothing about the command inside: the first version parsed perfectly and
// watched the wrong repository, because it passed no argument and `reeve run`
// fell back to detecting the repo from WorkingDirectory's git remote.
//
// The structural assertions run everywhere, including the Linux CI runner, so
// the guard is not decorative in the one place that runs automatically. Only the
// assertions about THIS machine are skipped elsewhere, and they are reported as
// SKIP rather than passed, because a check that quietly narrows its input is
// answering a smaller question than the one it claims.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";

const PLIST = new URL("../deploy/com.revnix.reeve.plist", import.meta.url).pathname;
const HOME = homedir();
// Overridable so the non-darwin branch is exercised here rather than discovered
// on the runner, which is how the plutil ENOENT was found the first time.
const onThisMac = (process.env.REEVE_FORCE_PLATFORM ?? platform()) === "darwin";
let fail = 0, skipped = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const skip = (name, why) => { console.log(`SKIP  ${name}`); console.log("        " + why); skipped++; };

/**
 * A minimal reader for the shape launchd agents actually use: a top-level dict of
 * string / bool / integer / array-of-string. Hand-rolled so the structural checks
 * do not depend on `plutil`, which exists only on macOS -- the first version of
 * this test used it and failed the Linux runner with ENOENT.
 */
function readPlist(path) {
  const xml = readFileSync(path, "utf8");
  const body = xml.slice(xml.indexOf("<dict>") + 6, xml.lastIndexOf("</dict>"));
  const out = {};
  const token = /<key>([\s\S]*?)<\/key>\s*(?:<(true|false)\s*\/>|<(string|integer)>([\s\S]*?)<\/\3>|<array>([\s\S]*?)<\/array>)/g;
  for (const m of body.matchAll(token)) {
    const key = m[1].trim();
    if (m[2]) out[key] = m[2] === "true";
    else if (m[3] === "integer") out[key] = Number(m[4]);
    else if (m[3] === "string") out[key] = m[4].trim();
    else if (m[5] != null) out[key] = [...m[5].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(a => a[1].trim());
  }
  return out;
}

let plist;
try { plist = readPlist(PLIST); check(true, "the plist parses"); }
catch (e) { check(false, "the plist parses", e.message); console.log(`\nfailed=${fail}`); process.exit(1); }

// Positive control for the hand reader: where the real parser exists, the two
// must agree, or every assertion below is measuring my regex rather than the file.
if (onThisMac) {
  try {
    const real = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", PLIST], { encoding: "utf8" }));
    const same = JSON.stringify(real.ProgramArguments) === JSON.stringify(plist.ProgramArguments)
      && real.KeepAlive === plist.KeepAlive && real.ThrottleInterval === plist.ThrottleInterval
      && real.StandardErrorPath === plist.StandardErrorPath;
    check(same, "control: the hand reader agrees with plutil",
      `plutil: ${JSON.stringify(real.ProgramArguments)}\n        ours:   ${JSON.stringify(plist.ProgramArguments)}`);
  } catch (e) { check(false, "control: the hand reader agrees with plutil", e.message); }
} else {
  skip("control: the hand reader agrees with plutil", "plutil is macOS-only");
}

const argv = plist.ProgramArguments ?? [];

// launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin and it never sources a profile,
// so nvm's shell function is unavailable and a bare `node` cannot resolve.
check(argv[0]?.startsWith("/"), "argv[0] is an absolute interpreter path", `got: ${argv[0]}`);
check(argv[1]?.startsWith("/"), "argv[1] is an absolute script path", `got: ${argv[1]}`);

// The repo must be STATED. Inference reads WorkingDirectory's git remote, which
// silently points the daemon at whatever checkout it starts in.
const nwo = argv.slice(2).find(a => /^[\w.-]+\/[\w.-]+$/.test(a));
check(Boolean(nwo), "the target repository is named explicitly, not inferred from WorkingDirectory",
  `args after the script: ${JSON.stringify(argv.slice(2))}`);

// The shadow week runs on neutral conclusions and no dispatch. Both are opt-in
// flags, so their ABSENCE is what must be asserted.
check(!argv.includes("--enforce"), "shadow mode: --enforce is absent", "a plist that enforces skips the shadow week");
check(!argv.includes("--execute"), "no dispatch: --execute is absent", "an unwatched first run must not act");

// KeepAlive turns any startup error into a restart loop, so the throttle floor is
// the only thing bounding the log.
check(plist.KeepAlive === true, "KeepAlive is set", `got: ${plist.KeepAlive}`);
check((plist.ThrottleInterval ?? 0) >= 10, "ThrottleInterval is at least 10s", `got: ${plist.ThrottleInterval}`);
check(typeof plist.StandardErrorPath === "string" && plist.StandardErrorPath.length > 0,
  "stderr is captured to a file", "exit 78 writes nothing; without this there is no diagnosis at all");

// --- assertions about THIS machine ------------------------------------------
// The plist hard-codes /Users/mobeen paths, so these can only be judged here.
if (!onThisMac) {
  skip("the interpreter exists and is Node >= 24", "the plist's paths exist only on the target Mac");
  skip("the named repo has a profile and a state database", "checks ~/.reeve on the target Mac");
} else {
  check(existsSync(argv[0]), "the interpreter exists", `missing: ${argv[0]}`);
  const ver = (() => { try { return execFileSync(argv[0], ["-v"], { encoding: "utf8" }).trim(); } catch { return "?"; } })();
  check(/^v(2[4-9]|[3-9]\d)\./.test(ver), "the interpreter is Node >= 24 (node:sqlite unflagged)", `got: ${ver}`);
  check(existsSync(argv[1]), "the script exists", `missing: ${argv[1]}`);

  if (nwo) {
    const [owner, repo] = nwo.split("/");
    const profile = join(HOME, ".reeve", "profiles", owner, `${repo}.json`);
    check(existsSync(profile), `a profile exists for ${nwo}`,
      "reeve run exits 1 without one, and KeepAlive then restarts it forever");
    check(existsSync(join(HOME, ".reeve", "state", `${repo}.db`)), `a state database exists for ${nwo}`,
      "reeve run exits 1 without one, and KeepAlive then restarts it forever");
    // Watching a repo the App cannot reach means every tick ends in a 404.
    try {
      const p = JSON.parse(readFileSync(profile, "utf8"));
      check(p.identity?.key === nwo, "the profile's identity matches the repo the plist names", `profile says ${p.identity?.key}`);
    } catch { check(false, "the profile's identity matches the repo the plist names", "profile unreadable"); }
  }
}

if (skipped) console.log(`\n${skipped} assertion(s) skipped off the target machine — not passed`);
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
