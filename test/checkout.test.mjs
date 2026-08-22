// A worker's checkout must share NOTHING with the founder's: not the ref store,
// not the configuration, and not their uncommitted work. These assertions are
// what makes the standalone clone a boundary rather than a convention.
import { prepareRunCheckout, releaseRunCheckout, fetchRunWork, publishRunWork, copyDeps, canCloneFiles, runPathFor, dependencyPathsFor } from "../src/checkout.mjs";
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
const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 42, runId: "run1", branch: "feature", head, depsFrom: ["node_modules"] });
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

// ── which dependency trees get copied comes from the profile ─────────────────
//
// node_modules was hard-coded. A python unit needs its .venv, and a language
// whose dependencies live under the home directory has nothing in the tree to
// copy at all — with no network and a scratch HOME that worker cannot resolve
// anything, so the gap is REPORTED rather than discovered as a mystery failure.
{
  check(JSON.stringify(dependencyPathsFor({ units: [{ root: ".", language: "typescript" }] }).paths) === '["node_modules"]',
    "a node unit asks for node_modules", "");
  check(JSON.stringify(dependencyPathsFor({ units: [{ root: "api", language: "python" }] }).paths) === '["api/.venv"]',
    "a python unit asks for its own .venv, under the unit's root", "");
  const go = dependencyPathsFor({ units: [{ root: ".", language: "go" }] });
  check(go.paths.length === 0 && go.unsupported.length === 1 && /go/.test(go.unsupported[0]),
    "a language cached under the home directory has nothing to copy, and SAYS so", JSON.stringify(go));
  check(JSON.stringify(dependencyPathsFor({ worker: { dependencyPaths: ["vendor"] }, units: [{ root: ".", language: "go" }] }).paths) === '["vendor"]',
    "and the profile can name its own, which overrides the table", "");

  // Two trees at once, each landing where it belongs in the run checkout.
  mkdirSync(join(founder, "api", ".venv", "lib"), { recursive: true });
  writeFileSync(join(founder, "api", ".venv", "lib", "mod.py"), "x = 1\n");
  const multi = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 77, runId: "r77", branch: "feature", head,
                                     depsFrom: ["node_modules", "api/.venv", "no/such/tree"] });
  check(multi.ok, "control: a checkout wanting several trees is prepared", JSON.stringify(multi.why));
  if (multi.ok) {
    check(existsSync(join(multi.path, "node_modules", "left-pad", "index.js")), "the node tree landed", "");
    check(existsSync(join(multi.path, "api", ".venv", "lib", "mod.py")), "the python tree landed under its unit's root", "");
    check(JSON.stringify(multi.deps.copied) === '["node_modules","api/.venv"]',
      "and a tree that does not exist is not an error, it is simply not copied", JSON.stringify(multi.deps));
    releaseRunCheckout(multi.path, { workFetched: true });
  }
}

// ── the ordinary case: a PR branch the founder has never checked out ─────────// ── the ordinary case: a PR branch the founder has never checked out ─────────
//
// A pull request's branch exists in the founder's clone as `origin/<branch>` and
// NOT as a local `refs/heads/<branch>`, unless a human happened to check it out.
// Every fixture above created the branch locally first, so none of them could
// exhibit what a real dispatch does. (Codex #5-[1].)
{
  const g2 = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();
  // A second contributor pushes a branch straight to the origin; the founder's
  // clone learns about it only as a remote-tracking ref.
  const other = join(root, "other");
  execFileSync("git", ["clone", "-q", origin, other]);
  g2(other, "checkout", "-q", "-b", "someone-elses-pr", "origin/main");
  writeFileSync(join(other, "theirs.txt"), "their work\n");
  g2(other, "add", "-A"); g2(other, "-c", "user.email=o@o", "-c", "user.name=o", "commit", "-q", "-m", "their fix");
  g2(other, "push", "-q", "origin", "someone-elses-pr");
  const theirHead = g2(other, "rev-parse", "HEAD");

  const localHeads = g2(founder, "for-each-ref", "--format=%(refname)", "refs/heads");
  check(!localHeads.includes("someone-elses-pr"),
    "control: the founder's clone has no local branch for it, which is the normal case", localHeads.replace(/\n/g, " "));

  const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 99, runId: "r99", branch: "someone-elses-pr", head: theirHead });
  check(r.ok, "a checkout is still prepared for a branch that exists only on the remote", JSON.stringify(r.why));
  if (r.ok) {
    check(g(r.path, "rev-parse", "HEAD") === theirHead, "at the revision reeve pinned", g(r.path, "rev-parse", "HEAD"));
    check(g(r.path, "rev-parse", "--abbrev-ref", "HEAD") === "someone-elses-pr", "on the pull request's branch, by name",
      g(r.path, "rev-parse", "--abbrev-ref", "HEAD"));
    check(existsSync(join(r.path, "theirs.txt")), "with their work in it", "");
    releaseRunCheckout(r.path, { workFetched: true });
  }
}

// ── the checkout carries ONLY the pinned history ─────────────────────────────
//
// `git clone` copies every branch and tag of the source and the objects behind
// them, so a private local branch in the founder's checkout arrived as
// `origin/private` in the worker's — readable with the worker's own git grant
// and copyable into an allowed path for reeve to publish. Denying the founder's
// checkout by path does nothing about a copy of its object database sitting
// inside the worker's own.
{
  // A branch the founder has locally and has never pushed.
  g(founder, "checkout", "-q", "-b", "private-notes", "main");
  writeFileSync(join(founder, "SECRET-PLANS.txt"), "not for a worker\n");
  g(founder, "add", "-A"); g(founder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "private");
  const secretSha = g(founder, "rev-parse", "HEAD");
  g(founder, "checkout", "-q", "main");

  const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 55, runId: "r55", branch: "feature", head });
  check(r.ok, "control: a checkout is prepared while the founder holds a private branch", JSON.stringify(r.why));
  if (r.ok) {
    const refs = g(r.path, "for-each-ref", "--format=%(refname)");
    check(!/private-notes/.test(refs), "the founder's other branches are NOT in the worker's checkout", refs.replace(/\n/g, " "));
    const hasObj = (() => { try { g(r.path, "cat-file", "-e", secretSha); return true; } catch { return false; } })();
    check(!hasObj, "nor are the objects behind them", `commit ${secretSha.slice(0, 10)} was reachable`);
    check(existsSync(join(r.path, "app.js")), "control: and the pull request's own content IS there", "");
    releaseRunCheckout(r.path, { workFetched: true });
  }
}

// ── a symlinked dependency destination is refused ────────────────────────────
//
// The destination sits inside PR-CONTROLLED content: a pull request can commit a
// symlink where a unit root belongs, and both mkdir and `cp -R` follow it, so
// the copy lands wherever the link points — written by the DAEMON, outside the
// checkout entirely.
//
// The SOURCE has to exist or the copy is skipped and the guard never runs. That
// is what the first version of this got wrong: it passed while proving nothing.
{
  const outside = join(root, "escape-target");
  mkdirSync(outside, { recursive: true });

  // A contributor pushes a branch whose `svc` unit root is a symlink out of the
  // tree. Built in a separate clone, so the founder's own working tree keeps the
  // real directory below.
  const evil = join(root, "evil-clone");
  execFileSync("git", ["clone", "-q", origin, evil]);
  const gE = (...a) => execFileSync("git", ["-C", evil, ...a], { encoding: "utf8" }).trim();
  gE("checkout", "-q", "-b", "symlinked", "origin/main");
  execFileSync("ln", ["-s", outside, join(evil, "svc")]);
  gE("add", "-A"); gE("-c", "user.email=o@o", "-c", "user.name=o", "commit", "-qm", "a symlinked unit root");
  gE("push", "-q", "origin", "symlinked");
  const evilHead = gE("rev-parse", "HEAD");

  // And the founder has the real dependency tree the daemon would copy FROM.
  mkdirSync(join(founder, "svc", ".venv"), { recursive: true });
  writeFileSync(join(founder, "svc", ".venv", "mod.py"), "x = 1\n");
  check(existsSync(join(founder, "svc", ".venv", "mod.py")), "control: the source tree exists, so a copy would be attempted", "");

  const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 66, runId: "r66", branch: "symlinked", head: evilHead,
                                 depsFrom: ["svc/.venv"] });
  check(!r.ok && /symlink/.test(r.why ?? ""), "a dependency path through a committed symlink refuses, and says so", JSON.stringify(r.why));
  check(!existsSync(join(outside, ".venv")), "and nothing was written outside the checkout", outside);
  check(!existsSync(runPathFor(runs, 66, "r66")), "and the half-built checkout is removed", "");
  rmSync(join(founder, "svc"), { recursive: true, force: true });
}

// ── a branch deleted while the worker ran is not recreated ───────────────────
//
// `git ls-remote` exits 0 and prints NOTHING when the ref is gone, so an empty
// result read as "unchanged" and the push recreated a branch someone deleted.
{
  const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 88, runId: "r88", branch: "feature", head: g(founder, "rev-parse", "origin/feature") });
  check(r.ok, "control: a checkout to publish from", JSON.stringify(r.why));
  if (r.ok) {
    writeFileSync(join(r.path, "fix.txt"), "a fix\n");
    g(r.path, "add", "-A"); g(r.path, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "the fix");
    const was = g(founder, "ls-remote", "origin", "refs/heads/feature").split(/\s+/)[0];
    g(founder, "push", "-q", "origin", "--delete", "feature");        // the contributor closes and deletes it
    const pub = publishRunWork({ repoRoot: founder, path: r.path, branch: "feature", expectedRemote: was });
    check(!pub.ok && /no longer exists/.test(pub.why ?? ""), "publishing to a deleted branch refuses", JSON.stringify(pub.why));
    const after = execFileSync("git", ["-C", origin, "for-each-ref", "--format=%(refname)"], { encoding: "utf8" });
    check(!/refs\/heads\/feature$/m.test(after), "and the branch stays deleted", after.replace(/\n/g, " "));
    releaseRunCheckout(r.path, { workFetched: false });
    rmSync(`${r.path}.unfetched`, { recursive: true, force: true });
  }
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
