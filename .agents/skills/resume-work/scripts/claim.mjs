#!/usr/bin/env node
// claim: take a task so that no other session works on it at the same time, or
// give it back.
//
// Assignment alone can't arbitrate. Two sessions of the same GitHub account can
// both "assign themselves", and each then sees only itself. So a claim also
// posts a comment carrying a random session id, and the earliest live claim
// since the task was last released wins (claimOutcome in lib.mjs). Every session
// computes the same answer from the same comments, so nothing else needs
// coordinating.
//
// A release is two writes: the assignment goes, then a release comment ends
// this login's claims. Each is checked before it is made, so running --release
// again finishes a release that stopped halfway.
//
// Usage: node claim.mjs --issue <n> [--repo owner/name]
//        node claim.mjs --issue <n> --release [--repo owner/name]
// Exit codes: 0 claimed or released; 1 refused (closed, blocked, held, or the
// race was lost); 2 GitHub could not be asked; 64 usage.
import { randomBytes } from "node:crypto";
import { gh, repoFromGit, isRepo, parseArgs, listComments, postComment, claimOutcome,
         unreleasedClaim, CLAIM, RELEASE } from "./lib.mjs";

process.on("uncaughtException", (err) => {
  console.error(`claim: GitHub could not be asked (${err.message})`);
  process.exit(2);
});

const args = parseArgs(process.argv.slice(2), { "--issue": "value", "--repo": "value", "--release": "switch" });
const repo = args.values?.repo ?? repoFromGit();
const issue = Number(args.values?.issue);
if (args.error || !isRepo(repo) || !Number.isInteger(issue) || issue <= 0) {
  if (args.error) console.error(`claim: ${args.error}`);
  console.error("usage: claim.mjs --issue <n> [--release] [--repo owner/name]");
  process.exit(64);
}
const me = gh(["api", "user", "--jq", ".login"]).trim();
const unassignMe = () => gh(["api", `repos/${repo}/issues/${issue}/assignees`, "--method", "DELETE",
  "-f", `assignees[]=${me}`, "--silent"]);

if (args.values.release) {
  const assigned = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}`, "--jq", "[.assignees[].login]"]));
  if (assigned.includes(me)) unassignMe();
  if (unreleasedClaim(listComments(repo, issue), me)) {
    postComment(repo, issue, `${RELEASE}\nReleased by @${me} at ${new Date().toISOString()}.`);
  }
  console.log(`released #${issue}`);
  process.exit(0);
}

const task = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}`]));
if (task.state !== "open") { console.log(`refused: #${issue} is ${task.state}`); process.exit(1); }
const blockers = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}/dependencies/blocked_by`]))
  .filter((b) => b.state === "open").map((b) => `#${b.number}`);
if (blockers.length) { console.log(`refused: #${issue} is blocked by ${blockers.join(", ")}`); process.exit(1); }
const others = (task.assignees ?? []).map((a) => a.login).filter((l) => l !== me);
if (others.length) { console.log(`refused: #${issue} is held by @${others.join(", @")}`); process.exit(1); }

const session = randomBytes(6).toString("hex");
gh(["api", `repos/${repo}/issues/${issue}/assignees`, "--method", "POST", "-f", `assignees[]=${me}`, "--silent"]);
postComment(repo, issue, `${CLAIM}session=${session} -->\nClaimed by @${me} (session ${session}) at ${new Date().toISOString()}.`);

const assignees = JSON.parse(gh(["api", `repos/${repo}/issues/${issue}`, "--jq", "[.assignees[].login]"]));
const outcome = claimOutcome(listComments(repo, issue), { session, me, assignees });
if (outcome.won) { console.log(`claimed #${issue}: ${task.title}`); process.exit(0); }

// Lost. Delete our own claim comment, so the thread shows one live claim.
if (outcome.mine) {
  try { gh(["api", `repos/${repo}/issues/comments/${outcome.mine.id}`, "--method", "DELETE", "--silent"]); }
  catch { /* the claim loses either way */ }
}
let note = "";
if (outcome.unassign) {
  try { unassignMe(); } catch { note = ` Remove your assignment from #${issue} by hand; it could not be removed.`; }
}
if (!outcome.winnerSession) {
  console.log(`refused: the claim on #${issue} could not be confirmed. Check that @${me} can be assigned to it.${note}`);
} else if (outcome.winnerLogin === me) {
  console.log(`refused: another session of @${me} (${outcome.winnerSession}) claimed #${issue} first. ` +
    `If that session has ended, resume #${issue} from its checkpoint instead of claiming it.`);
} else {
  console.log(`refused: @${outcome.winnerLogin} (session ${outcome.winnerSession}) claimed #${issue} first. Pick another task.${note}`);
}
process.exit(1);
