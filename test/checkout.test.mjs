// A worker's checkout must share NOTHING with the founder's: not the ref store,
// not the configuration, and not their uncommitted work. These assertions are
// what makes the standalone clone a boundary rather than a convention.
import { prepareRunCheckout, releaseRunCheckout, fetchRunWork, publishRunWork, copyDeps, canCloneFiles, runPathFor, dependencyPathsFor } from "../src/checkout.mjs";
import { verifyConfig } from "../src/gitguard.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
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

// ── a tree whose checkout filters cannot run is refused ──────────────────────
//
// Daemon git runs with no global or system configuration — that is what stops a
// founder's filter driver executing on pull-request content. It also means Git
// LFS's driver, which `git lfs install` registers globally, is absent. Git
// treats an undefined filter as PASS-THROUGH rather than an error, so the
// checkout would succeed holding pointer files and the worker would edit and
// test a tree that is not the code.
{
  const lfsish = join(root, "lfs-clone");
  execFileSync("git", ["clone", "-q", origin, lfsish]);
  const gL = (...a) => execFileSync("git", ["-C", lfsish, ...a], { encoding: "utf8" }).trim();
  gL("checkout", "-q", "-b", "filtered", "origin/main");
  writeFileSync(join(lfsish, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n");
  writeFileSync(join(lfsish, "asset.bin"), "pointer\n");
  gL("add", "-A"); gL("-c", "user.email=o@o", "-c", "user.name=o", "commit", "-qm", "an LFS-tracked asset");
  gL("push", "-q", "origin", "filtered");
  const filteredHead = gL("rev-parse", "HEAD");

  const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 77, runId: "r77", branch: "filtered", head: filteredHead });
  check(!r.ok && /filter/.test(r.why ?? ""),
    "a tree declaring a checkout filter reeve cannot supply is REFUSED, not silently passed through", JSON.stringify(r.why));
  check(/lfs/.test(r.why ?? ""), "and the refusal names the filter", JSON.stringify(r.why));
  check(!existsSync(runPathFor(runs, 77, "r77")), "and the half-built checkout is removed", "");

  // The control: an ordinary tree, no filter declared, still prepares.
  const plain = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 78, runId: "r78", branch: "main",
                                     head: g(founder, "rev-parse", "refs/remotes/origin/main") });
  check(plain.ok, "control: a tree that declares no filter is unaffected", JSON.stringify(plain.why));
  if (plain.ok) releaseRunCheckout(plain.path, { workFetched: true });
  rmSync(lfsish, { recursive: true, force: true });
}

// ── the founder's repository keeps the founder's configuration ───────────────
//
// The isolation exists because a worker's checkout holds pull-request content.
// Applied to the founder's own repository it removes the things reeve needs
// there: measured 2026-08-22 against revnix/reeve, `ls-remote origin` succeeded
// ordinarily and failed under the isolation with "could not read Username for
// 'https://github.com'", because the credential helper is global.
//
// A credential cannot be put in a fixture, so this reproduces the same
// mechanism with the other global key that decides how git reaches a remote: a
// `url.<base>.insteadOf` rewrite, which is what SSH rewrites and corporate
// proxies use. Origin is a URL that resolves ONLY through it.
{
  const home = join(root, "founder-home");
  const remote = join(root, "rewritten.git");
  const repo = join(root, "rewritten-founder");
  mkdirSync(home, { recursive: true });
  execFileSync("git", ["init", "--bare", "-q", remote]);
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(home, ".gitconfig"), `[url "${remote}"]\n\tinsteadOf = reeve-fixture://origin\n`);
  writeFileSync(join(repo, "app.js"), "console.log(1)\n");
  g(repo, "add", "-A"); g(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  g(repo, "remote", "add", "origin", "reeve-fixture://origin");

  const wasHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // The fixture's own precondition: the rewrite is real, and nothing else can
    // resolve this URL. Without it the case below would pass for the wrong reason.
    execFileSync("git", ["-C", repo, "push", "-q", "origin", "HEAD:refs/heads/rewritten"], { encoding: "utf8", env: { ...process.env, HOME: home } });
    let unresolvable = "";
    try { execFileSync("git", ["-C", repo, "ls-remote", "origin"], { encoding: "utf8", env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { unresolvable = String(e.stderr || e.message); }
    check(/reeve-fixture/.test(unresolvable),
      "control: without the founder's global config the origin cannot be resolved at all", JSON.stringify(unresolvable.slice(0, 120)));

    // An EXPLICIT GIT_CONFIG_GLOBAL is the founder naming where their
    // configuration lives -- a company file supplying the rewrite or the
    // credential helper -- and dropping it puts git back on a ~/.gitconfig that
    // carries neither. Only reeve's OWN isolation value is discarded.
    const company = join(root, "company.gitconfig");
    writeFileSync(company, `[url "${remote}"]\n\tinsteadOf = reeve-company://origin\n`);
    const bare = join(root, "bare-home");
    mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, ".gitconfig"), "# no rewrite here\n");

    const rewrittenHead = g(repo, "rev-parse", "HEAD");
    const rw = prepareRunCheckout({ repoRoot: repo, root: runs, pr: 82, runId: "r82", branch: "rewritten", head: rewrittenHead });
    check(rw.ok, "a checkout prepares though origin resolves only through the founder's global config", JSON.stringify(rw.why));

    if (rw.ok) releaseRunCheckout(rw.path, { workFetched: true });

    // Publication is exercised SEPARATELY, on a checkout built by hand, so that
    // it cannot be skipped by the case above failing: a stub that breaks only
    // the push must still turn this red rather than leave it unrun.
    const worker = join(root, "rewritten-worker");
    // Cloned, then put on the branch by REVISION: `rewritten` exists on the
    // remote and not as a local head in the founder's checkout, and
    // `clone --branch` asks the source for a local head.
    execFileSync("git", ["clone", "-q", repo, worker]);
    g(worker, "checkout", "-q", "-B", "rewritten", rewrittenHead);
    writeFileSync(join(worker, "app.js"), "console.log(2)\n");
    g(worker, "add", "-A"); g(worker, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "the worker's fix");
    const pub = publishRunWork({ repoRoot: repo, path: worker, branch: "rewritten", expectedRemote: rewrittenHead });
    check(pub.ok, "and the work publishes through it", JSON.stringify(pub.why));
    const onRemote = (() => { try { return g(remote, "rev-parse", "refs/heads/rewritten"); } catch { return "(unreadable)"; } })();
    check(onRemote === g(worker, "rev-parse", "HEAD"), "the remote carries what the worker committed", onRemote);
    rmSync(worker, { recursive: true, force: true });

    // 1. reeve's own isolation value, inherited: discarded, so the founder's
    //    ~/.gitconfig is read and the rewrite still resolves.
    const wasIso = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    const iso = prepareRunCheckout({ repoRoot: repo, root: runs, pr: 83, runId: "r83", branch: "rewritten", head: rewrittenHead });
    check(iso.ok, "an inherited GIT_CONFIG_GLOBAL=/dev/null is discarded, not honoured", JSON.stringify(iso.why));
    if (iso.ok) releaseRunCheckout(iso.path, { workFetched: true });

    // 2. an explicit founder-chosen file: KEPT, and it is the only thing that
    //    can resolve this origin -- the home config in scope carries no rewrite.
    process.env.GIT_CONFIG_GLOBAL = company;
    process.env.HOME = bare;
    g(repo, "remote", "set-url", "origin", "reeve-company://origin");
    let unresolvableC = "";
    try { execFileSync("git", ["-C", repo, "ls-remote", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
                                                                     env: { ...process.env, HOME: bare, GIT_CONFIG_GLOBAL: "/dev/null" } }); }
    catch (e) { unresolvableC = String(e.stderr || e.message); }
    check(/reeve-company/.test(unresolvableC),
      "control: without that file the company origin cannot be resolved either", JSON.stringify(unresolvableC.slice(0, 110)));

    const explicit = prepareRunCheckout({ repoRoot: repo, root: runs, pr: 84, runId: "r84", branch: "rewritten", head: rewrittenHead });
    check(explicit.ok, "an explicit GIT_CONFIG_GLOBAL is KEPT, so the founder's chosen config still applies", JSON.stringify(explicit.why));
    if (explicit.ok) releaseRunCheckout(explicit.path, { workFetched: true });
    if (wasIso === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = wasIso;
    process.env.HOME = home;
  } finally {
    if (wasHome === undefined) delete process.env.HOME; else process.env.HOME = wasHome;
  }
}

// ── and it keeps its isolation everywhere the founder's config is not needed ─
//
// The other half of the same rule. The worker-to-founder fetch reads a LOCAL
// path: it needs no credential and no rewrite, and a founder who has hardened
// git with `protocol.file.allow=never` would otherwise have it refused —
// measured 2026-08-22 on git 2.50.1, `fatal: transport 'file' not allowed` —
// and with it every valid fix, before anything could be pushed.
{
  const home = join(root, "hardened-home");
  const repo = join(root, "hardened-founder");
  const worker = join(root, "hardened-worker");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, ".gitconfig"), '[protocol "file"]\n\tallow = never\n');
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  writeFileSync(join(repo, "app.js"), "console.log(1)\n");
  g(repo, "add", "-A"); g(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base");
  execFileSync("git", ["clone", "-q", repo, worker]);
  g(worker, "checkout", "-q", "-B", "hardened");
  writeFileSync(join(worker, "app.js"), "console.log(2)\n");
  g(worker, "add", "-A"); g(worker, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "the worker's fix");

  const wasHome = process.env.HOME;
  process.env.HOME = home;
  try {
    // The fixture's own precondition: the hardening is real and it does bite.
    let refused = "";
    try { execFileSync("git", ["-C", repo, "fetch", "--no-tags", "-q", worker, "+hardened:refs/control/one"],
                       { encoding: "utf8", env: { ...process.env, HOME: home }, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { refused = String(e.stderr || e.message); }
    check(/transport 'file' not allowed/.test(refused),
      "control: the founder's hardening refuses a plain fetch from the worker's checkout", JSON.stringify(refused.slice(0, 100)));

    const got = fetchRunWork({ repoRoot: repo, path: worker, branch: "hardened" });
    check(got.ok, "reeve's fetch of the worker's branch survives it", JSON.stringify(got.why));
    check(got.head === g(worker, "rev-parse", "HEAD"), "and lands on what the worker committed", `${got.head}`);
  } finally {
    if (wasHome === undefined) delete process.env.HOME; else process.env.HOME = wasHome;
  }
  rmSync(worker, { recursive: true, force: true });
}

// ── an attributes file reeve will not read ───────────────────────────────────
//
// The tree is PULL-REQUEST content, and `.gitattributes` can be committed as a
// symlink — mode 120000, which a clone materialises. The reader followed it.
// Measured 2026-08-22 on git 2.50.1: one pointing at /dev/zero was listed by
// `ls-files` and killed the reading process outright (SIGKILL, exit 137), so a
// pull request could take the daemon down before a worker was ever launched.
//
// The fixture points somewhere harmless instead, at a file that DOES declare a
// filter: if reeve still read through the link it would name that filter, so
// the refusal naming the link rather than the filter is the evidence that it
// did not.
{
  const outside = join(root, "outside-attrs");
  writeFileSync(outside, "* filter=absolutely-not-supplied\n");

  const linked = join(root, "linked-clone");
  execFileSync("git", ["clone", "-q", origin, linked]);
  const gS = (...a) => execFileSync("git", ["-C", linked, ...a], { encoding: "utf8" }).trim();
  gS("checkout", "-q", "-b", "linked-attrs", "origin/main");
  symlinkSync(outside, join(linked, ".gitattributes"));
  gS("add", "-A"); gS("-c", "user.email=o@o", "-c", "user.name=o", "commit", "-qm", "attributes, as a link");
  check(/^120000 /.test(gS("ls-files", "-s", ".gitattributes")),
    "control: git committed the attributes file as a symlink, and a clone materialises it", gS("ls-files", "-s", ".gitattributes"));
  gS("push", "-q", "origin", "linked-attrs");
  const linkedHead = gS("rev-parse", "HEAD");

  const rl = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 79, runId: "r79", branch: "linked-attrs", head: linkedHead });
  check(!rl.ok && /symbolic link/.test(rl.why ?? ""),
    "an attributes file committed as a symlink is refused unread", JSON.stringify(rl.why));
  check(!/absolutely-not-supplied/.test(rl.why ?? ""),
    "and reeve never read through it — the filter beyond the link is not named", JSON.stringify(rl.why));
  check(!existsSync(runPathFor(runs, 79, "r79")), "and the half-built checkout is removed", "");

  // The same reader, unbounded, on an attributes file larger than any real one.
  const big = join(root, "big-clone");
  execFileSync("git", ["clone", "-q", origin, big]);
  const gB = (...a) => execFileSync("git", ["-C", big, ...a], { encoding: "utf8" }).trim();
  gB("checkout", "-q", "-b", "big-attrs", "origin/main");
  writeFileSync(join(big, ".gitattributes"), "#".repeat(2 << 20) + "\n");
  gB("add", "-A"); gB("-c", "user.email=o@o", "-c", "user.name=o", "commit", "-qm", "a very large attributes file");
  gB("push", "-q", "origin", "big-attrs");
  const bigHead = gB("rev-parse", "HEAD");

  const rb = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 80, runId: "r80", branch: "big-attrs", head: bigHead });
  check(!rb.ok && /bytes/.test(rb.why ?? ""),
    "an attributes file past the size reeve will read is refused", JSON.stringify(rb.why));

  // The control that says the bound is a bound and not a ban: an ordinary
  // attributes file, declaring an attribute that is not a filter, still prepares.
  const ok = join(root, "ok-clone");
  execFileSync("git", ["clone", "-q", origin, ok]);
  const gO = (...a) => execFileSync("git", ["-C", ok, ...a], { encoding: "utf8" }).trim();
  gO("checkout", "-q", "-b", "ok-attrs", "origin/main");
  writeFileSync(join(ok, ".gitattributes"), "*.md text eol=lf\n");
  gO("add", "-A"); gO("-c", "user.email=o@o", "-c", "user.name=o", "commit", "-qm", "ordinary attributes");
  gO("push", "-q", "origin", "ok-attrs");
  const okHead = gO("rev-parse", "HEAD");

  const ro = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 81, runId: "r81", branch: "ok-attrs", head: okHead });
  check(ro.ok, "control: an ordinary attributes file is read and the checkout prepares", JSON.stringify(ro.why));
  if (ro.ok) releaseRunCheckout(ro.path, { workFetched: true });
  rmSync(linked, { recursive: true, force: true });
  rmSync(big, { recursive: true, force: true });
  rmSync(ok, { recursive: true, force: true });
}

// ── the branch check is atomic with the push ─────────────────────────────────
//
// `ls-remote` is a look, not a lock. A branch deleted or moved between it and
// the push would be recreated, or landed on, by an ordinary push. The remote
// verifies the expectation itself now — and the push is refused first unless the
// work DESCENDS from what it replaces, because a lease is not a licence to
// rewrite somebody's history.
{
  // Its own branch: an earlier case deletes `feature` from the origin, and a
  // fixture that depends on the order of the ones before it is a fixture that
  // breaks for reasons that are not the code.
  g(founder, "checkout", "-q", "-B", "leased", "main");
  writeFileSync(join(founder, "leased-base.txt"), "base\n");
  g(founder, "add", "-A"); g(founder, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "leased base");
  g(founder, "push", "-q", "origin", "leased");
  g(founder, "checkout", "-q", "main");
  const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 91, runId: "r91", branch: "leased",
                                 head: g(founder, "rev-parse", "refs/remotes/origin/leased") });
  check(r.ok, "control: a checkout to publish from", JSON.stringify(r.why));
  if (r.ok) {
    writeFileSync(join(r.path, "leased.txt"), "a fix\n");
    g(r.path, "add", "-A"); g(r.path, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "the fix");
    const was = g(founder, "ls-remote", "origin", "refs/heads/leased").split(/\s+/)[0];

    // Someone else lands a commit AFTER reeve looked. The lease must catch it.
    const other = join(root, "racer");
    execFileSync("git", ["clone", "-q", "-b", "leased", origin, other]);
    writeFileSync(join(other, "theirs.txt"), "landed first\n");
    execFileSync("git", ["-C", other, "add", "-A"]);
    execFileSync("git", ["-C", other, "-c", "user.email=o@o", "-c", "user.name=o", "commit", "-qm", "theirs"]);
    execFileSync("git", ["-C", other, "push", "-q", "origin", "leased"]);
    const theirs = execFileSync("git", ["-C", other, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    const pub = publishRunWork({ repoRoot: founder, path: r.path, branch: "leased", expectedRemote: was });
    check(!pub.ok, "a remote that moved after the look refuses the push", JSON.stringify(pub.why));
    check(g(founder, "ls-remote", "origin", "refs/heads/leased").split(/\s+/)[0] === theirs,
      "and the other party's commit is still what the branch points at", "");
    releaseRunCheckout(r.path, { workFetched: false });
    rmSync(`${r.path}.unfetched`, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
}

// ── reeve does not rewrite published history, lease or no lease ──────────────
{
  const head2 = g(founder, "rev-parse", "refs/remotes/origin/leased");
  const r = prepareRunCheckout({ repoRoot: founder, root: runs, pr: 92, runId: "r92", branch: "leased", head: head2 });
  check(r.ok, "control: a checkout for the rewrite case", JSON.stringify(r.why));
  if (r.ok) {
    // A worker that rebased or amended: its branch no longer descends from the
    // revision reeve pinned. A plain push refuses this; a lease would NOT.
    g(r.path, "reset", "--hard", "-q", g(r.path, "rev-list", "--max-parents=0", "HEAD"));
    writeFileSync(join(r.path, "rewritten.txt"), "an unrelated history\n");
    g(r.path, "add", "-A"); g(r.path, "-c", "user.email=w@w", "-c", "user.name=w", "commit", "-qm", "rewritten");
    const before = g(founder, "ls-remote", "origin", "refs/heads/leased").split(/\s+/)[0];
    const pub = publishRunWork({ repoRoot: founder, path: r.path, branch: "leased", expectedRemote: before });
    check(!pub.ok && /does not descend|rewrite/.test(pub.why ?? ""),
      "a branch that does not descend from the pinned head is refused, though the lease would have allowed it", JSON.stringify(pub.why));
    check(g(founder, "ls-remote", "origin", "refs/heads/leased").split(/\s+/)[0] === before,
      "and the remote is untouched", "");
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
