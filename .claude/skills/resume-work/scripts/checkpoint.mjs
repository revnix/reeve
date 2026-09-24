#!/usr/bin/env node
// checkpoint: record on a task where the work stopped, so any session on any
// machine can continue from it.
//
// It refuses when the current branch has uncommitted, unpushed or stashed work.
// A checkpoint that points at one machine's disk can't be resumed anywhere else.
// Pass --no-branch for a task that has no branch, such as a settings change.
//
// Usage: node checkpoint.mjs --issue <n> --done "…" --remaining "…"
//          [--validation "…"] [--blockers "…"] [--next "…"] [--pr owner/repo#n]
//          [--no-branch] [--repo owner/name]
// Exit codes: 0 posted; 1 refused; 2 GitHub could not be asked; 64 usage.
import { execFileSync } from "node:child_process";
import { repoFromGit, isRepo, parseArgs, postComment, formatCheckpoint, stashedOn } from "./lib.mjs";

const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
process.on("uncaughtException", (err) => {
  console.error(`checkpoint: GitHub could not be asked (${err.message})`);
  process.exit(2);
});

const args = parseArgs(process.argv.slice(2), {
  "--issue": "value", "--done": "value", "--remaining": "value", "--validation": "value",
  "--blockers": "value", "--next": "value", "--pr": "value", "--repo": "value", "--no-branch": "switch" });
const v = args.values ?? {};
const repo = v.repo ?? repoFromGit();
const issue = Number(v.issue);
if (args.error || !isRepo(repo) || !Number.isInteger(issue) || issue <= 0 || !v.done || !v.remaining) {
  if (args.error) console.error(`checkpoint: ${args.error}`);
  console.error("usage: checkpoint.mjs --issue <n> --done \"…\" --remaining \"…\" [--validation \"…\"] [--blockers \"…\"] [--next \"…\"] [--pr owner/repo#n] [--no-branch] [--repo owner/name]");
  process.exit(64);
}
const refuse = (why) => { console.log(`refused: ${why}`); process.exit(1); };

const fields = { pr: v.pr, done: v.done, remaining: v.remaining,
                 validation: v.validation ?? "not run", blockers: v.blockers ?? "none", next: v.next };
if (!v["no-branch"]) {
  let branch, dirty, stash, upstream = null, unpushed = 0;
  try {
    branch = git(["branch", "--show-current"]);
    fields.head = git(["rev-parse", "--short", "HEAD"]);
    dirty = git(["status", "--porcelain"]);
    stash = git(["stash", "list", "--format=%gs"]).split("\n").filter(Boolean);
  } catch { refuse("not inside a git checkout. Pass --no-branch if this task has no branch."); }
  try { upstream = git(["rev-parse", "--abbrev-ref", "@{u}"]); unpushed = Number(git(["rev-list", "--count", "@{u}..HEAD"])); }
  catch { upstream = null; }
  if (!branch) refuse("HEAD is detached. Check out the task's branch first.");
  if (dirty) refuse("uncommitted changes. Commit them, push, then checkpoint.");
  const stashed = stashedOn(branch, stash);
  if (stashed.length) {
    refuse(`${stashed.length} stash entr${stashed.length > 1 ? "ies were" : "y was"} made on ${branch} ("${stashed[0]}"). ` +
      "A stash stays on this machine: commit and push that work, or drop the entry, then checkpoint.");
  }
  if (!upstream) refuse(`${branch} has no upstream. Push it (git push -u origin ${branch}), then checkpoint.`);
  if (unpushed > 0) refuse(`${unpushed} commit(s) on ${branch} are not pushed. Push, then checkpoint.`);
  fields.branch = branch;
}

postComment(repo, issue, formatCheckpoint(fields));
console.log(`checkpoint posted on ${repo}#${issue}`);
