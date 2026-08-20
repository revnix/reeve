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
import { acquireWorktree, verifyWorktree, releaseWorktree } from "../src/worktree.mjs";
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
  git(r2.path, "push", "-q", "origin", "HEAD:feature2");
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
}

rmSync(base, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
