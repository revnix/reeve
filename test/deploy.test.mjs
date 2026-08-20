// The launchd agent is the one artifact that runs with no human watching, so a
// mistake in it is silent for a whole night. Plist syntax validating proves
// nothing about the command inside: the first version parsed perfectly and
// watched the wrong repository, because it passed no argument and `reeve run`
// fell back to detecting the repo from WorkingDirectory's git remote.
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const PLIST = new URL("../deploy/com.revnix.reeve.plist", import.meta.url).pathname;
const HOME = homedir();
let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// Read it the way launchd does, so a malformed plist fails here rather than at
// load time with exit 78 and an empty log.
let plist;
try {
  plist = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", PLIST], { encoding: "utf8" }));
  check(true, "the plist parses as a property list");
} catch (e) {
  check(false, "the plist parses as a property list", e.message);
  console.log(`\nfailed=${fail}`); process.exit(1);
}

const argv = plist.ProgramArguments ?? [];

// launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin and it never sources a profile,
// so nvm's shell function is not available and a bare `node` cannot resolve.
check(argv[0]?.startsWith("/") && existsSync(argv[0]),
  "argv[0] is an absolute interpreter path that exists", `got: ${argv[0]}`);

const ver = (() => { try { return execFileSync(argv[0], ["-v"], { encoding: "utf8" }).trim(); } catch { return "?"; } })();
check(/^v(2[4-9]|[3-9]\d)\./.test(ver), "the interpreter is Node >= 24 (node:sqlite unflagged)", `got: ${ver}`);

check(argv[1]?.startsWith("/") && existsSync(argv[1]), "argv[1] is an absolute script path that exists", `got: ${argv[1]}`);

// The repo must be stated, never inferred. Inference reads WorkingDirectory's
// git remote, which silently points the daemon at whatever checkout it starts in.
const nwo = argv.slice(2).find(a => /^[\w.-]+\/[\w.-]+$/.test(a));
check(Boolean(nwo), "the target repository is named explicitly, not inferred from WorkingDirectory",
  `args after the script: ${JSON.stringify(argv.slice(2))}`);

if (nwo) {
  const [owner, repo] = nwo.split("/");
  check(existsSync(join(HOME, ".reeve", "profiles", owner, `${repo}.json`)),
    `a profile exists for ${nwo}`, "reeve run exits 1 without one, and KeepAlive restarts it forever");
  check(existsSync(join(HOME, ".reeve", "state", `${repo}.db`)),
    `a state database exists for ${nwo}`, "reeve run exits 1 without one, and KeepAlive restarts it forever");

  // Watching a repo the App cannot reach means every tick ends in a 404 and no
  // evidence accumulates. The profile carries the identity the App is installed on.
  try {
    const p = JSON.parse(readFileSync(join(HOME, ".reeve", "profiles", owner, `${repo}.json`), "utf8"));
    check(p.identity?.key === nwo, "the profile's identity matches the repo the plist names", `profile says ${p.identity?.key}`);
  } catch { check(false, "the profile's identity matches the repo the plist names", "profile unreadable"); }
}

// The shadow week runs on neutral conclusions and no dispatch. Both are opt-in
// flags, so their ABSENCE is what must be asserted.
check(!argv.includes("--enforce"), "shadow mode: --enforce is absent", "a plist that enforces skips the shadow week");
check(!argv.includes("--execute"), "no dispatch: --execute is absent", "an unwatched first run must not act");

// KeepAlive turns any startup error into a restart loop, so the throttle floor
// is the only thing bounding the log.
check(plist.KeepAlive === true, "KeepAlive is set");
check((plist.ThrottleInterval ?? 0) >= 10, "ThrottleInterval is at least 10s", `got: ${plist.ThrottleInterval}`);
check(typeof plist.StandardErrorPath === "string" && plist.StandardErrorPath.length > 0,
  "stderr is captured to a file", "exit 78 writes nothing; without this there is no diagnosis at all");

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
