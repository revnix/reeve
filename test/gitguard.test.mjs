// The configuration fingerprint: reeve refuses to run git at all in a checkout
// whose repository configuration moved since it wrote it.
//
// `core.fsmonitor` names a program git RUNS, and the daemon runs `git status` in
// the checkout, unsandboxed, before publishing. The `-c` neutralisers cover the
// keys they can name; they cannot blanket-clear `filter.<name>.clean`, whose
// driver name comes from the repository's own .gitattributes. So the barrier is
// not a list of dangerous keys — it is that ANY change to the configuration
// stops the daemon reading or publishing that checkout.
//
// Driven against REAL git repositories rather than mocks, because every rule
// here is about what git actually reports and a mock would simply agree with me.
import { verifyConfig, recordConfig, configEntries, reason, GIT_NEUTRALISE, REFUSING_HOOK } from "../src/gitguard.mjs";
import { prepareRunCheckout } from "../src/checkout.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

// ── fixture: an origin, the founder's checkout, and a run checkout ────────────
const root = mkdtempSync(join(tmpdir(), "reeve-gitguard-"));
const origin = join(root, "o.git"), founder = join(root, "founder"), runs = join(root, "runs");
execFileSync("git", ["init", "--bare", "-q", origin]);
execFileSync("git", ["clone", "-q", origin, founder]);
g(founder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
g(founder, "push", "-q", "origin", "HEAD:main");
g(founder, "checkout", "-q", "-b", "feat");
g(founder, "push", "-q", "origin", "feat");
const head = g(founder, "rev-parse", "HEAD");
g(founder, "checkout", "-q", "main");

const mk = (pr, runId) => prepareRunCheckout({ repoRoot: founder, root: runs, pr, runId, branch: "feat", head });

// ── the baseline, and what a normal worker session does to it ────────────────
{
  const w = mk(1, "r1");
  check(w.ok, "control: a run checkout was prepared", JSON.stringify(w.why));
  check(verifyConfig(w.path).ok === true, "control: a freshly prepared checkout verifies", JSON.stringify(verifyConfig(w.path)));

  // The positive control that matters most. A fingerprint that fired on an
  // ordinary commit would discard every successful run: the worker is TOLD to
  // commit, and its identity comes from GIT_CONFIG_GLOBAL in the run's tmp, so
  // a normal session must leave the repository configuration alone.
  writeFileSync(join(w.path, "fix.txt"), "the worker's fix\n");
  g(w.path, "add", "-A");
  g(w.path, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "fix: what a worker actually does");
  check(verifyConfig(w.path).ok === true,
    "and a full add/commit cycle does not disturb it — the check does not fire on ordinary work",
    JSON.stringify(verifyConfig(w.path)));
}

// ── a planted executable config is caught, and named ─────────────────────────
{
  const w = mk(2, "r2");
  check(w.ok, "control: a checkout to tamper with", JSON.stringify(w.why));
  g(w.path, "config", "core.fsmonitor", "./payload");
  const after = verifyConfig(w.path);
  check(after.ok === false && /core\.fsmonitor/.test(after.why), "a planted executable config is caught, and named", JSON.stringify(after));
  check(after.keys.includes("core.fsmonitor"), "and reported as a key, so a caller can say which one", JSON.stringify(after.keys));
}

// ── a key reeve set as a containment layer is not exempt ─────────────────────
//
// The linked-worktree version allowed reeve's own keys to move, because a daemon
// upgrade re-hardened a worktree it had made earlier. A run checkout is built
// once and never re-hardened, so that allowance only ever let a worker overwrite
// the two keys reeve sets to stop it publishing, in silence.
{
  const w = mk(3, "r3");
  check(w.ok, "control: a checkout whose hooks path reeve set", JSON.stringify(w.why));
  check(g(w.path, "config", "--local", "core.hooksPath") === `${w.path}.hooks`,
    "control: reeve's refusing hook is configured", g(w.path, "config", "--local", "core.hooksPath"));
  g(w.path, "config", "--local", "core.hooksPath", join(w.path, "mine"));
  const after = verifyConfig(w.path);
  check(after.ok === false && after.keys.includes("core.hookspath"),
    "a worker overwriting core.hooksPath is caught, though reeve set that key itself", JSON.stringify(after));
}
{
  const w = mk(4, "r4");
  g(w.path, "config", "--local", "remote.origin.pushurl", "file:///tmp/anywhere");
  const after = verifyConfig(w.path);
  check(after.ok === false && after.keys.includes("remote.origin.pushurl"),
    "and so is a worker restoring a working push URL", JSON.stringify(after));
}

// ── an unrecorded checkout is a refusal, not a pass ──────────────────────────
{
  const bare = mkdtempSync(join(tmpdir(), "reeve-gitguard-none-"));
  const r = verifyConfig(bare);
  check(r.ok === false && /no recorded/.test(r.why), "a checkout with no recorded configuration does not verify", JSON.stringify(r));
  rmSync(bare, { recursive: true, force: true });
}
{
  // The daemon reaches this shape when preparation failed and it has no path at
  // all. It must read as "nothing to vouch for", never as a pass.
  const r = verifyConfig(join(root, "no-such-checkout"));
  check(r.ok === false, "and neither does a path that does not exist", JSON.stringify(r));
}

// ── recordConfig re-baselines, so a caller can see the two are distinct ──────
{
  const w = mk(5, "r5");
  g(w.path, "config", "core.fsmonitor", "./payload");
  check(verifyConfig(w.path).ok === false, "control: tampered", "");
  check(recordConfig(w.path) === true, "recording again succeeds", "");
  check(verifyConfig(w.path).ok === true, "and re-baselines — which is why nothing in the dispatch path calls it twice", "");
  const entries = configEntries(w.path);
  check(Array.isArray(entries["--local"]) && entries["--local"].some(l => l.startsWith("core.fsmonitor=")),
    "configEntries reports the local scope as sorted entries", JSON.stringify(entries["--local"]).slice(0, 200));
}

// ── the pieces the rest of the daemon imports from here ──────────────────────
{
  check(GIT_NEUTRALISE.includes("core.fsmonitor=") && GIT_NEUTRALISE.includes("core.hooksPath=/dev/null"),
    "the neutralisers name the keys git would execute", JSON.stringify(GIT_NEUTRALISE.filter(x => x !== "-c")));
  check(/^#!/.test(REFUSING_HOOK) && /does not publish/.test(REFUSING_HOOK), "the refusing hook is a script that says why", "");
  check(reason("Preparing worktree (resetting branch)\nfatal: cannot force update the branch\nsome trailing noise") === "fatal: cannot force update the branch",
    "reason picks git's fatal line, not the last thing it printed", reason("Preparing worktree\nfatal: cannot force update the branch\nsome trailing noise"));
  check(reason("") === "git failed with no message", "and says so when git said nothing", reason(""));
}

// ── the checkout carries the hook the fingerprint protects ───────────────────
{
  const w = mk(6, "r6");
  check(existsSync(join(`${w.path}.hooks`, "pre-push")), "the refusing hook is written beside the checkout, not inside it", `${w.path}.hooks`);
}

rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
