// Worktree lifecycle. reeve validated that a path EXISTED and was absolute, and
// nothing more: not that it was a worktree, not that it belonged to this
// repository, not that it was on the pull request's branch, not that someone had
// left work in it. A worker would have been dropped into whatever was there.
//
// Driven against REAL git repositories rather than mocks, because every rule here
// is about what git actually reports and a mock would simply agree with me.
//
// The release side is ported from the old plugin's reaper, whose four refusals
// were each earned by destroying work at least once: uncommitted edits are
// invisible to a naive check, a branch with no upstream was never pushed,
// unpushed commits vanish with the directory, and the stash stack is SHARED
// across every worktree of a clone, so a non-empty stack may hold a stranger's
// work in progress. On any doubt it quarantines rather than deletes.
import { acquireWorktree, verifyWorktree, releaseWorktree, pushWorktree, verifyConfig, configEntries, recordConfig } from "../src/worktree.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" }).trim();

// A bare "remote" plus a clone, so upstream tracking is real rather than implied.
const base = mkdtempSync(join(tmpdir(), "reeve-wt-"));
const remote = join(base, "remote.git");
const repo = join(base, "clone");
const roots = join(base, "worktrees");

execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
execFileSync("git", ["clone", "-q", remote, repo]);
for (const [k, v] of [["user.email", "t@t"], ["user.name", "t"], ["commit.gpgsign", "false"]]) git(repo, "config", k, v);
writeFileSync(join(repo, "a.txt"), "one\n");
git(repo, "add", "-A"); git(repo, "commit", "-qm", "first"); git(repo, "push", "-q", "origin", "main");

// A PR branch on the remote, as a real pull request head would be.
git(repo, "checkout", "-qb", "feature");
writeFileSync(join(repo, "b.txt"), "two\n");
git(repo, "add", "-A"); git(repo, "commit", "-qm", "second"); git(repo, "push", "-q", "-u", "origin", "feature");
const featureHead = git(repo, "rev-parse", "HEAD");
git(repo, "checkout", "-q", "main");

// --- acquire ------------------------------------------------------------------
let wt;
{
  const r = acquireWorktree({ repoRoot: repo, root: roots, pr: 7, branch: "feature", head: featureHead });
  check(r.ok, "control: a worktree is created for the PR branch", JSON.stringify(r));
  wt = r.path;
  check(existsSync(wt), "and it exists on disk", wt);
  check(git(wt, "rev-parse", "--abbrev-ref", "HEAD") === "feature", "on the PR's branch, not the default one");
  check(git(wt, "rev-parse", "HEAD") === featureHead, "at the head reeve pinned");
}
{
  // Acquiring twice must reuse, not fail and not silently make a second one.
  const again = acquireWorktree({ repoRoot: repo, root: roots, pr: 7, branch: "feature", head: featureHead });
  check(again.ok && again.path === wt, "acquiring again reuses the same worktree", JSON.stringify(again));
  check(again.reused === true, "and says so, rather than looking like a fresh checkout", JSON.stringify(again.reused));
}

// --- verify: every refusal the audit asked for --------------------------------
{
  const r = verifyWorktree({ path: wt, branch: "feature", head: featureHead });
  check(r.ok, "control: a clean, correct worktree verifies", JSON.stringify(r));
}
{
  const r = verifyWorktree({ path: join(base, "not-a-worktree"), branch: "feature", head: featureHead });
  check(!r.ok && /not a git worktree|does not exist/i.test(r.why ?? ""),
    "a path that is not a worktree refuses", JSON.stringify(r));
}
{
  const r = verifyWorktree({ path: repo, branch: "feature", head: featureHead });
  check(!r.ok, "the main checkout itself refuses — a worker must never run in it", JSON.stringify(r));
}
{
  const r = verifyWorktree({ path: wt, branch: "some-other-branch", head: featureHead });
  check(!r.ok && /branch/i.test(r.why ?? ""), "the wrong branch refuses", JSON.stringify(r));
}
{
  writeFileSync(join(wt, "stray.txt"), "someone was here\n");
  const r = verifyWorktree({ path: wt, branch: "feature", head: featureHead });
  check(!r.ok && /uncommitted|unrelated/i.test(r.why ?? ""),
    "unrelated uncommitted work refuses — that is somebody's unsaved change", JSON.stringify(r));
  rmSync(join(wt, "stray.txt"));
}
{
  // A head that has ADVANCED from the pin is fine: that is the worker's own commit.
  writeFileSync(join(wt, "c.txt"), "three\n");
  git(wt, "add", "-A"); git(wt, "commit", "-qm", "worker commit");
  const r = verifyWorktree({ path: wt, branch: "feature", head: featureHead });
  check(r.ok, "a head that cleanly ADVANCES from the pin is accepted", JSON.stringify(r));
}
{
  // A head that has diverged is not.
  const r = verifyWorktree({ path: wt, branch: "feature", head: "0".repeat(40) });
  check(!r.ok && /descend|diverge|unrelated/i.test(r.why ?? ""),
    "a head that does not descend from the pin refuses", JSON.stringify(r));
}

// --- release ------------------------------------------------------------------
{
  // Unpushed work must never be deleted.
  const r = releaseWorktree({ path: wt, pr: 7 });
  check(!r.ok && /unpushed/i.test(r.why ?? ""), "unpushed commits refuse release", JSON.stringify(r));
  check(r.quarantined === true, "and the directory is QUARANTINED rather than removed", JSON.stringify(r));
  check(!existsSync(wt), "so the original path is gone");
  const q = join(roots, "_quarantine");
  check(existsSync(q) && readdirSync(q).length === 1, "moved intact into quarantine", q);
}
{
  // The clean path: push first, then release really removes it.
  // Its own branch, as a real second pull request would have. This also proves
  // the quarantine above pruned git's admin: without that, git still believed
  // `feature` was checked out at the moved path.
  git(repo, "checkout", "-qb", "feature2");
  writeFileSync(join(repo, "d.txt"), "four\n");
  git(repo, "add", "-A"); git(repo, "commit", "-qm", "third"); git(repo, "push", "-q", "-u", "origin", "feature2");
  const f2 = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "main");
  const r2 = acquireWorktree({ repoRoot: repo, root: roots, pr: 8, branch: "feature2", head: f2 });
  check(r2.ok, "control: a second worktree, on its own branch", JSON.stringify(r2));
  // From the MAIN checkout, because a worktree can no longer publish — which is
  // the point. This is how reeve does it.
  pushWorktree({ path: r2.path, branch: "feature2", repoRoot: repo });
  const rel = releaseWorktree({ path: r2.path, pr: 8 });
  check(rel.ok, "a clean, fully pushed worktree releases", JSON.stringify(rel));
  check(!existsSync(r2.path), "and is actually gone");
  check(!git(repo, "worktree", "list").includes("pr-8"),
    "with git's own worktree admin pruned, not just the directory removed",
    git(repo, "worktree", "list"));
}


// A worker that stops mid-task leaves the checkout dirty, and the next attempt
// cannot use it -- verifyWorktree refuses, correctly, and the pull request is then
// stuck with no path out. Measured live: a worker repaired the planted bug and hit
// its turn limit before committing, leaving a correct fix that cost real money and
// blocked every later attempt while looking like nothing had happened.
//
// Releasing a dirty worktree preserves it instead of deleting it, which is what
// makes recovering the work possible at all.
{
  const r3 = acquireWorktree({ repoRoot: repo, root: roots, pr: 9, branch: "feature2", head: git(repo, "rev-parse", "origin/feature2") });
  check(r3.ok, "control: a worktree for an unfinished worker", JSON.stringify(r3));
  writeFileSync(join(r3.path, "half-done.txt"), "a fix the worker never committed\n");
  check(!verifyWorktree({ path: r3.path, branch: "feature2" }).ok,
    "control: while dirty, the next attempt cannot use it");
  const rel = releaseWorktree({ path: r3.path, pr: 9 });
  check(!rel.ok && rel.quarantined, "releasing it preserves the work rather than deleting it", JSON.stringify(rel));
  check(existsSync(join(rel.path, "half-done.txt")), "and the unfinished file is still there", rel.path);
  const fresh = acquireWorktree({ repoRoot: repo, root: roots, pr: 9, branch: "feature2", head: git(repo, "rev-parse", "origin/feature2") });
  check(fresh.ok, "so the next attempt gets a clean one instead of being stuck", JSON.stringify(fresh));
  // Hand the branch back, or the next case cannot check it out — git allows one
  // worktree per branch, which is the same constraint the quarantine case proved.
  releaseWorktree({ path: fresh.path, pr: 9 });
}


// The diff gate must see COMMITTED work, not only uncommitted work.
//
// The prompt tells a worker to commit. Committing leaves a clean tree. A gate that
// reads `git status --porcelain` therefore reported a complete, correct, committed
// fix as "the worker produced an empty diff -- nothing was changed" and refused to
// publish it. The instrument could not represent the success case it existed to
// check, and it failed CLOSED, which is the right direction and still wrong.
{
  const r4 = acquireWorktree({ repoRoot: repo, root: roots, pr: 11, branch: "feature2", head: git(repo, "rev-parse", "origin/feature2") });
  check(r4.ok, "control: a worktree to work in", JSON.stringify(r4));
  const pinned = git(r4.path, "rev-parse", "HEAD");

  writeFileSync(join(r4.path, "fixed.txt"), "the fix\n");
  git(r4.path, "add", "-A");
  git(r4.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fix: the worker committed its work");

  check(git(r4.path, "status", "--porcelain") === "",
    "control: after committing, the working tree is CLEAN — which is why a status-only gate saw nothing");
  const committed = git(r4.path, "diff", "--name-only", `${pinned}..HEAD`).split("\n").filter(Boolean);
  check(committed.includes("fixed.txt"),
    "but comparing against the pinned head shows the change", JSON.stringify(committed));
}


// A worker must not be able to publish, and that must NOT depend on a permission
// pattern refusing it.
//
// git accepts flags before the subcommand, so `git -C <path> push` does not match
// a `git push` rule. That is the shape of the mechanism, not a gap to patch: any
// deny written as a subcommand pattern has the same hole. A worker used exactly
// that to publish its own fix and bypass the diff gate entirely.
//
// The earlier check of this passed because it used the BARE `git push` form,
// which the pattern does match — a fixture that could not exhibit the defect it
// was written to rule out. This one uses the form that broke it.
{
  const r5 = acquireWorktree({ repoRoot: repo, root: roots, pr: 12, branch: "feature", head: git(repo, "rev-parse", "origin/feature") });
  check(r5.ok, "control: a worktree to publish from", JSON.stringify(r5));

  writeFileSync(join(r5.path, "worker-change.txt"), "something to publish\n");
  git(r5.path, "add", "-A");
  git(r5.path, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "a change the worker would like to publish");
  const before = git(repo, "ls-remote", "origin", "refs/heads/feature").split(/\s+/)[0];

  // The exact form that defeated the permission rule.
  let pushed = false;
  try { git(r5.path, "push", "origin", "HEAD:feature"); pushed = true; } catch { pushed = false; }
  check(!pushed, "a push FROM THE WORKTREE fails, whatever the command spells", "it succeeded");

  const after = git(repo, "ls-remote", "origin", "refs/heads/feature").split(/\s+/)[0];
  check(after === before, "and the remote did not move", `${before.slice(0,10)} -> ${after.slice(0,10)}`);

  // The bogus pushurl stops a push to origin. A push to an explicit file:// or
  // https:// URL never consults it; the worktree's own hook is the layer that
  // catches that shape. Git's error text is asserted so the refusing layer is
  // named, not inferred.
  {
    const bare = mkdtempSync(join(tmpdir(), "reeve-bare-escape-"));
    execFileSync("git", ["init", "--bare", "-q", bare]);
    let code = 0, err = "";
    try { execFileSync("git", ["-C", r5.path, "push", bare, "HEAD:refs/heads/escape"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (e) { code = e.status; err = String(e.stderr); }
    check(code !== 0 && /does not publish/.test(err),
      "a push to an explicit URL is refused by the worktree's own hook", `code=${code} ${err.slice(0, 200)}`);
    const refs = execFileSync("git", ["-C", bare, "for-each-ref"], { encoding: "utf8" }).trim();
    check(refs === "", "and nothing reached the destination", refs);
    const hooksPath = git(r5.path, "config", "--worktree", "core.hooksPath");
    check(hooksPath === `${r5.path}.hooks` && existsSync(join(hooksPath, "pre-push")),
      "the hooks path is this worktree's own sibling directory, set with --worktree", hooksPath);
    let mainHooks = "(unset)";
    try { mainHooks = git(repo, "config", "--get", "core.hooksPath") || "(unset)"; } catch { mainHooks = "(unset)"; }
    check(mainHooks === "(unset)", "and the main checkout's hooks are untouched", mainHooks);
    rmSync(bare, { recursive: true, force: true });
  }

  // A worktree that predates the hook (a daemon upgrade finds a verified
  // worktree from before) must be hardened on REUSE, not only on creation.
  {
    rmSync(`${r5.path}.hooks`, { recursive: true, force: true });
    git(r5.path, "config", "--worktree", "--unset", "core.hooksPath");
    const again = acquireWorktree({ repoRoot: repo, root: roots, pr: 12, branch: "feature", head: git(repo, "rev-parse", "origin/feature") });
    check(again.ok && again.reused === true, "control: the worktree was reused, not recreated", JSON.stringify(again));
    let hp = "(unset)";
    try { hp = git(r5.path, "config", "--worktree", "core.hooksPath"); } catch { hp = "(unset)"; }
    check(hp === `${r5.path}.hooks` && existsSync(join(hp, "pre-push")),
      "a reused worktree is hardened again: hook present and configured", hp);
  }

  // A hook file that lost its executable bit is silently ignored by git; reuse
  // must restore and verify the mode, not merely rewrite the bytes.
  {
    const { chmodSync, statSync: st } = await import("node:fs");
    chmodSync(join(`${r5.path}.hooks`, "pre-push"), 0o644);
    const again = acquireWorktree({ repoRoot: repo, root: roots, pr: 12, branch: "feature", head: git(repo, "rev-parse", "origin/feature") });
    check(again.ok && (st(join(`${r5.path}.hooks`, "pre-push")).mode & 0o111) !== 0, "a reused hook has its executable bit restored", JSON.stringify(again));
  }

  // Hardening that cannot be applied must refuse the worktree, never hand it
  // back with a layer missing. A regular file where the hooks directory must
  // go is the cheapest way to make the hook step fail.
  {
    const { pathFor } = await import("../src/worktree.mjs");
    const p13 = pathFor(roots, 13);
    writeFileSync(`${p13}.hooks`, "not a directory\n");
    git(repo, "push", "-q", "origin", "origin/feature:refs/heads/feature13");   // a branch no worktree holds
    const r13 = acquireWorktree({ repoRoot: repo, root: roots, pr: 13, branch: "feature13", head: git(repo, "rev-parse", "origin/feature13") });
    check(r13.ok === false && /harden/i.test(r13.why ?? ""), "a worktree whose hardening fails is refused, with the reason", JSON.stringify(r13));
    rmSync(`${p13}.hooks`, { force: true });
  }

  // The confinement must be per-worktree. A plain `git config` write from inside a
  // worktree lands in the SHARED clone config and disables push everywhere,
  // including the main checkout — which is how the first version of this broke the
  // setup of a later case rather than the case it was guarding.
  // `git config --get` exits 1 when the key is absent, which is the expected case.
  const mainPush = (() => {
    try { return git(repo, "config", "--get", "remote.origin.pushurl") || "(unset)"; }
    catch { return "(unset)"; }
  })();
  check(mainPush === "(unset)",
    "the main checkout keeps a working pushurl — the crippling is confined to the worktree", mainPush);

  // reeve, from the main checkout, still can.
  const ok = pushWorktree({ path: r5.path, branch: "feature", repoRoot: repo });
  check(ok.ok, "but reeve publishes from the main checkout", JSON.stringify(ok));
  const final = git(repo, "ls-remote", "origin", "refs/heads/feature").split(/\s+/)[0];
  check(final !== before, "and the remote moves when IT does", `${before.slice(0,10)} -> ${final.slice(0,10)}`);
}

rmSync(base, { recursive: true, force: true });

// ── the worker must not be able to make the daemon's own git execute anything ──
//
// `core.fsmonitor` names a program git RUNS, and the daemon runs `git status` in
// the worktree, unsandboxed, before publishing. The barrier is that reeve refuses
// to run git at all in a worktree whose configuration changed since it wrote it.
{
  const root = mkdtempSync(join(tmpdir(), "reeve-cfg-"));
  const g = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
  const origin = join(root, "o.git"), clone = join(root, "c");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  execFileSync("git", ["clone", "-q", origin, clone]);
  g(clone, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "base");
  g(clone, "push", "-q", "origin", "HEAD:main");
  g(clone, "checkout", "-q", "-b", "feat");
  g(clone, "push", "-q", "origin", "feat");   // acquireWorktree fetches the branch from the remote
  const head = g(clone, "rev-parse", "HEAD");
  g(clone, "checkout", "-q", "main");
  const w = acquireWorktree({ repoRoot: clone, root: join(root, "wts"), pr: 7, branch: "feat", head });
  check(w.ok, "control: the worktree was created", JSON.stringify(w));
  check(verifyConfig(w.path).ok === true, "control: a freshly hardened worktree verifies", JSON.stringify(verifyConfig(w.path)));
  // The worker plants a config value git would execute.
  g(w.path, "config", "core.fsmonitor", "./payload");
  const after = verifyConfig(w.path);
  check(after.ok === false && /core\.fsmonitor/.test(after.why) && /reeve does not own/.test(after.why),
    "a planted executable config is caught, and named", JSON.stringify(after));
  // acquire must refuse BEFORE running git in it: verifying a worktree runs
  // `git status`, which a worker-added .gitattributes + filter.<name>.clean turns
  // into code execution as the daemon user. The directory is moved aside without
  // any git command, so the next tick builds a clean one.
  const reacquire = acquireWorktree({ repoRoot: clone, root: join(root, "wts"), pr: 7, branch: "feat", head });
  check(reacquire.ok === false && /reeve does not own/.test(reacquire.why) && /moved to/.test(reacquire.why),
    "and re-acquiring that worktree refuses without running git in it", JSON.stringify(reacquire));
  check(!existsSync(w.path), "the tampered directory is moved aside, so the next acquire starts clean", "");
  // A worker that CHANGES an existing key must not cost the clone its real value:
  // blanket --unset-all on remote.origin.url would delete the legitimate origin
  // and leave the main checkout unable to fetch or push.
  {
    const w3 = acquireWorktree({ repoRoot: clone, root: join(root, "wts"), pr: 9, branch: "feat", head });
    check(w3.ok, "control: a worktree for the url case", JSON.stringify(w3));
    const realUrl = g(clone, "config", "--local", "--get", "remote.origin.url");
    check(realUrl === origin, "control: the clone's origin is the real one", realUrl);
    g(w3.path, "config", "remote.origin.url", "https://example.invalid/evil.git");
    const re = acquireWorktree({ repoRoot: clone, root: join(root, "wts"), pr: 9, branch: "feat", head });
    check(re.ok === false && /remote\.origin\.url/.test(re.why), "the changed key is caught", JSON.stringify(re.why));
    // `git config --get` exits 1 when the key is gone, and a DELETED origin is
    // exactly the failure under test, so this read must not throw.
    const readUrl = () => { try { return g(clone, "config", "--local", "--get", "remote.origin.url"); } catch { return "(deleted)"; } };
    const restored = readUrl();
    check(restored === origin, "and the clone's ORIGINAL origin is restored, not deleted", restored);
  }

  // reeve's OWN keys moving is a daemon upgrade re-hardening, not tampering.
  const w2 = acquireWorktree({ repoRoot: clone, root: join(root, "wts"), pr: 7, branch: "feat", head });
  check(w2.ok, "control: a fresh worktree is created after the quarantine", JSON.stringify(w2));
  g(w2.path, "config", "--worktree", "--unset", "core.hooksPath");
  check(verifyConfig(w2.path).ok === true, "a change to a key reeve owns is not treated as tampering", JSON.stringify(verifyConfig(w2.path)));
  // And an unrecorded worktree is a refusal, not a pass.
  const bare = mkdtempSync(join(tmpdir(), "reeve-cfg-none-"));
  check(verifyConfig(bare).ok === false, "a worktree with no recorded configuration does not verify", "");
  rmSync(root, { recursive: true, force: true }); rmSync(bare, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
