#!/usr/bin/env node
// claim: take a task so that no other session works on it at the same time, or
// give it back.
//
// Assignment alone can't arbitrate. Two sessions of the same GitHub account can
// both "assign themselves", and each then sees only itself. So a claim also
// posts a comment carrying a random session id. The earliest claim comment since
// the task was last released wins. Every session computes the same answer from
// the same comments, so nothing else needs coordinating.
//
// Usage: node claim.mjs --issue <n> [--repo owner/name]
//        node claim.mjs --issue <n> --release [--repo owner/name]
// Exit codes: 0 claimed or released; 1 refused (closed, blocked, held, or the
// race was lost); 2 GitHub could not be asked; 64 usage.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const argv = process.argv.slice(2);
const opt = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const CLAIM = "<!-- claim v1 ", RELEASE = "<!-- release v1 -->";

function gh(args, input) {
  let last = null;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      return execFileSync("gh", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
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
  console.error(`claim: GitHub could not be asked (${err.message})`);
  process.exit(2);
});

function repoFromGit() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

const repo = opt("--repo") ?? repoFromGit();
const issue = Number(opt("--issue"));
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo) || !Number.isInteger(issue) || issue <= 0) {
  console.error("usage: claim.mjs --issue <n> [--release] [--repo owner/name]");
  process.exit(64);
}
const me = gh(["api", "user", "--jq", ".login"]).trim();
// One compact JSON object per line. `--slurp` would be simpler but is newer than
// the gh some machines still carry.
const comments = () => gh(["api", "--paginate", `repos/${repo}/issues/${issue}/comments`,
  "--jq", ".[] | {id, body, at: .created_at} | @json"])
  .split("\n").filter(Boolean).map((l) => JSON.parse(l)).map((c) => ({ ...c, body: c.body ?? "" }));

// A comment is posted once. If an attempt fails, look before trying again: a
// timed-out request may have been delivered.
function postOnce(body) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try { gh(["api", `repos/${repo}/issues/${issue}/comments`, "--method", "POST", "-f", `body=${body}`, "--silent"]); return; }
    catch (err) {
      if (comments().some((c) => c.body === body)) return;
      if (attempt === 4) throw err;
    }
  }
}

if (argv.includes("--release")) {
  postOnce(`${RELEASE}\nReleased by @${me} at ${new Date().toISOString()}.`);
  gh(["api", `repos/${repo}/issues/${issue}/assignees`, "--method", "DELETE", "-f", `assignees[]=${me}`, "--silent"]);
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
postOnce(`${CLAIM}session=${session} -->\nClaimed by @${me} (session ${session}) at ${new Date().toISOString()}.`);

// The earliest claim after the latest release wins. Comments come back oldest first.
const all = comments();
const lastRelease = all.map((c) => c.body.startsWith(RELEASE)).lastIndexOf(true);
const claims = all.slice(lastRelease + 1).filter((c) => c.body.startsWith(CLAIM));
const winner = claims[0]?.body.match(/session=([0-9a-f]+)/)?.[1];
if (winner === session) { console.log(`claimed #${issue}: ${task.title}`); process.exit(0); }
// Lost the race. Delete our own claim comment so the thread shows one claim.
// Leave the assignment alone: under the same account it is the winner's too.
const mine = all.find((c) => c.body.includes(`session=${session} -->`));
if (mine) { try { gh(["api", `repos/${repo}/issues/comments/${mine.id}`, "--method", "DELETE", "--silent"]); } catch { /* the claim still loses */ } }
console.log(`refused: another session (${winner ?? "unknown"}) claimed #${issue} first. Pick another task.`);
process.exit(1);
