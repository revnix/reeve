#!/usr/bin/env node
// checkpoint: record on a task where the work stopped, so any session on any
// machine can continue from it.
//
// It refuses when the current branch has uncommitted or unpushed work. A
// checkpoint that points at one machine's disk can't be resumed anywhere else.
// Pass --no-branch for a task that has no branch, such as a settings change.
//
// Usage: node checkpoint.mjs --issue <n> --done "…" --remaining "…"
//          [--validation "…"] [--blockers "…"] [--next "…"] [--pr owner/repo#n]
//          [--no-branch] [--repo owner/name]
// Exit codes: 0 posted; 1 refused; 2 GitHub could not be asked; 64 usage.
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function gh(args) {
  let last = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      last = err;
      const why = String(err.stderr ?? "");
      if ((/HTTP 4\d\d/.test(why) && !/HTTP 429/.test(why)) || /GraphQL:/.test(why)) break;
      pause(2500 * attempt);
    }
  }
  throw new Error(String(last?.stderr ?? last?.message ?? "").trim().split("\n")[0]);
}
process.on("uncaughtException", (err) => {
  console.error(`checkpoint: GitHub could not be asked (${err.message})`);
  process.exit(2);
});

function repoFromGit() {
  try {
    const m = git(["remote", "get-url", "origin"]).match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

const repo = opt("--repo") ?? repoFromGit();
const issue = Number(opt("--issue"));
const done = opt("--done"), remaining = opt("--remaining");
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || !Number.isInteger(issue) || issue <= 0 || !done || !remaining) {
  console.error("usage: checkpoint.mjs --issue <n> --done \"…\" --remaining \"…\" [--validation \"…\"] [--blockers \"…\"] [--next \"…\"] [--pr owner/repo#n] [--no-branch] [--repo owner/name]");
  process.exit(64);
}

const lines = ["<!-- checkpoint v1 -->"];
if (!argv.includes("--no-branch")) {
  let branch, head, dirty, upstream, unpushed;
  try {
    branch = git(["branch", "--show-current"]);
    head = git(["rev-parse", "--short", "HEAD"]);
    dirty = git(["status", "--porcelain"]);
  } catch {
    console.log("refused: not inside a git checkout. Pass --no-branch if this task has no branch.");
    process.exit(1);
  }
  try { upstream = git(["rev-parse", "--abbrev-ref", "@{u}"]); unpushed = Number(git(["rev-list", "--count", "@{u}..HEAD"])); }
  catch { upstream = null; }
  if (!branch) { console.log("refused: HEAD is detached. Check out the task's branch first."); process.exit(1); }
  if (dirty) { console.log("refused: uncommitted changes. Commit them, push, then checkpoint."); process.exit(1); }
  if (!upstream) { console.log(`refused: ${branch} has no upstream. Push it (git push -u origin ${branch}), then checkpoint.`); process.exit(1); }
  if (unpushed > 0) { console.log(`refused: ${unpushed} commit(s) on ${branch} are not pushed. Push, then checkpoint.`); process.exit(1); }
  lines.push(`branch:      ${branch}`, `head:        ${head}`);
}
const pr = opt("--pr");
if (pr) lines.push(`pr:          ${pr}`);
lines.push(`done:        ${done}`, `remaining:   ${remaining}`);
lines.push(`validation:  ${opt("--validation") ?? "not run"}`);
lines.push(`blockers:    ${opt("--blockers") ?? "none"}`);
if (opt("--next")) lines.push(`next:        ${opt("--next")}`);
const body = lines.join("\n");

// Posted once: after a failed attempt, look before retrying, because a timed-out
// request may have been delivered.
const posted = () => gh(["api", "--paginate", `repos/${repo}/issues/${issue}/comments`, "--jq", ".[] | .body | @json"])
  .split("\n").filter(Boolean).some((l) => JSON.parse(l) === body);
for (let attempt = 1; attempt <= 4; attempt++) {
  try { gh(["api", `repos/${repo}/issues/${issue}/comments`, "--method", "POST", "-f", `body=${body}`, "--silent"]); break; }
  catch (err) { if (posted()) break; if (attempt === 4) throw err; }
}
console.log(`checkpoint posted on ${repo}#${issue}`);
