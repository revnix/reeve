// A worker's checkout must share NOTHING with the founder's: not the ref store,
// not the configuration, and not their uncommitted work. These assertions are
// what makes the standalone clone a boundary rather than a convention.
import { prepareRunCheckout, releaseRunCheckout, fetchRunWork, copyDeps, canCloneFiles, runPathFor } from "../src/checkout.mjs";
import { verifyConfig } from "../src/gitguard.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const g = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

// ── fixture: an origin, the founder's checkout, and a run root ────────────────
const root = mkdtempSync(join(tmpdir(), "reeve-checkout-"));
const origin = join(root, "o.git"), founder = join(root, "founder"), runs = join(root, "runs");
execFileSync("git", ["init", "--bare", "-q", origin]);
execFileSync("git", ["clone", "-q", origin, founder]);
writeFileSync(join(founder, "app.js"), "console.log(1)\n");
g(founder, "add", "-A"); g(founder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "base");
g(founder, "push", "-q", "origin", "HEAD:main");
g(founder, "checkout", "-q", "-b", "feature");
writeFileSync(join(founder, "app.js"), "console.log(2)\n");
g(founder, "add", "-A"); g(founder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "feature work");
g(founder, "push", "-q", "origin", "feature");
const head = g(founder, "rev-parse", "HEAD");
g(founder, "checkout", "-q", "main");
// The founder's own uncommitted work and an ignored secret, which a `cp` of the
// checkout would have handed straight to the worker.
writeFileSync(join(founder, "WIP.txt"), "the founder's unfinished work\n");
writeFileSync(join(founder, ".env"), "SECRET=hunter2\n");
writeFileSync(join(founder, ".gitignore"), ".env\nnode_modules/\n");
g(founder, "add", ".gitignore"); g(founder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "ignore");
// A dependency tree the worker cannot install for itself (no network).
mkdirSync(join(founder, "node_modules", "left-pad"), { recursive: true });
writeFileSync(join(founder, "node_modules", "left-pad", "index.js"), "module.exports = 1\n");

// ── the checkout is standalone, current, and carries nothing of the founder's ─
const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 42, runId: "run1", branch: "feature", head, depsFrom: join(founder, "node_modules") });
check(r.ok, "control: a run checkout is prepared", JSON.stringify(r.why));
check(r.path === runPathFor(runs, 42, "run1"), "at a path keyed by run, not by pull request", r.path);
check(existsSync(join(r.path, ".git")) && !existsSync(join(r.path, ".git", "..", "..", "founder")), "with its own .git", "");
check(g(r.path, "rev-parse", "HEAD") === head, "standing on the revision reeve pinned", g(r.path, "rev-parse", "HEAD"));
check(!existsSync(join(r.path, "WIP.txt")), "the founder's uncommitted work is NOT in it", "");
check(!existsSync(join(r.path, ".env")), "nor their ignored secrets", "");
check(existsSync(join(r.path, "node_modules", "left-pad", "index.js")), "but the dependencies are, so a fixer can run the tests", JSON.stringify(r.deps));

// ── nothing it does can reach the founder's checkout ──────────────────────────
{
  const before = g(founder, "rev-parse", "refs/heads/main");
  g(r.path, "update-ref", "refs/heads/main", head);           // the shared-ref attack
  check(g(founder, "rev-parse", "refs/heads/main") === before, "moving a branch in the run checkout does not move the founder's", "");
  g(r.path, "config", "core.fsmonitor", "./payload");          // the shared-config attack
  const fcfg = (() => { try { return g(founder, "config", "--local", "--get", "core.fsmonitor"); } catch { return "(unset)"; } })();
  check(fcfg === "(unset)", "and writing an executable config does not reach the founder's clone either", fcfg);
  // reeve's own detection still applies to the run checkout.
  check(verifyConfig(r.path).ok === false, "the config check still catches it in the run checkout", JSON.stringify(verifyConfig(r.path)));
}

// ── the work comes OUT by fetch, and only then may the checkout go ────────────
{
  const r2 = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 43, runId: "run2", branch: "feature", head, depsFrom: null });
  check(r2.ok, "control: a second checkout", JSON.stringify(r2.why));
  writeFileSync(join(r2.path, "app.js"), "console.log(3)\n");
  g(r2.path, "add", "-A"); g(r2.path, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-q", "-m", "the worker's fix");
  const worked = g(r2.path, "rev-parse", "HEAD");
  const f = fetchRunWork({ repoRoot: founder, path: r2.path, branch: "feature" });
  check(f.ok && f.head === worked, "reeve fetches the worker's commit into its OWN checkout", JSON.stringify(f));
  check(g(founder, "cat-file", "-t", worked) === "commit", "so the commit exists there without the worker ever pushing", "");
  // A release that has not confirmed the fetch must not delete the only copy.
  const kept = releaseRunCheckout(r2.path, { workFetched: false });
  check(kept.ok && kept.quarantined === true && !existsSync(r2.path), "an unfetched checkout is preserved, never deleted", JSON.stringify(kept));
  rmSync(kept.path, { recursive: true, force: true });
}

// ── the copy-on-write path is used where the filesystem allows it ─────────────
{
  const cow = canCloneFiles(root);
  const dest = join(root, "nm-copy");
  const c = copyDeps(join(founder, "node_modules"), dest);
  check(c.ok && existsSync(join(dest, "left-pad", "index.js")), "dependencies copy either way", JSON.stringify(c));
  check(c.cow === cow, "and the cheap path is taken exactly when the filesystem supports it", `cow=${c.cow} supported=${cow}`);
  const missing = copyDeps(join(root, "no-such-dir"), join(root, "nm2"));
  check(missing.ok && missing.skipped === true, "a project with no dependencies is not an error", JSON.stringify(missing));
}

// ── a run checkout is never silently reused ──────────────────────────────────
{
  const again = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 42, runId: "run1", branch: "feature", head });
  check(again.ok === false && /already exists/.test(again.why), "preparing over an existing checkout refuses", JSON.stringify(again.why));
}

releaseRunCheckout(r.path, { workFetched: true });
check(!existsSync(r.path), "a fetched checkout is removed", "");
rmSync(root, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
