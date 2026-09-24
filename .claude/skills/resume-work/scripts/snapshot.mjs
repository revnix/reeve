#!/usr/bin/env node
// snapshot: where work stands, for a repository whose plan and state live in
// GitHub (issues, sub-issues, blocked-by links, checkpoint comments, pull
// requests). It only reads; it never changes anything.
//
// Usage: node snapshot.mjs [--repo owner/name] [--limit 5]
// Exit codes: 0 printed, 2 GitHub could not be asked, 64 usage.
import { execFileSync } from "node:child_process";

const argv = process.argv.slice(2);
const opt = (flag, fallback = null) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Retry a dropped connection. Don't retry an answer that won't change: a 4xx
// refusal (other than 429) or a GraphQL schema error.
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
  console.error(`snapshot: GitHub could not be asked (${err.message})`);
  process.exit(2);
});
const graphql = (query, vars) =>
  JSON.parse(gh(["api", "graphql", "-f", `query=${query}`,
    ...Object.entries(vars).flatMap(([k, v]) => ["-F", `${k}=${v}`])])).data;

function repoFromGit() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

const repo = opt("--repo") ?? repoFromGit();
if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) {
  console.error("snapshot: no repository. Run inside a clone, or pass --repo owner/name.");
  process.exit(64);
}
const [owner, name] = repo.split("/");
const limit = Math.max(1, Number(opt("--limit", "5")) || 5);
const me = gh(["api", "user", "--jq", ".login"]).trim();

// ── pull requests, and what each is waiting for ──────────────────────────────
const prPage = graphql(`query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){
  pullRequests(states:OPEN, first:100, orderBy:{field:UPDATED_AT, direction:DESC}){ pageInfo{ hasNextPage } nodes{
    number title isDraft author{ login } reviewDecision mergeable
    reviewThreads(first:100){ nodes{ isResolved } }
    commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{
      __typename ... on CheckRun{ name status conclusion } ... on StatusContext{ context state } } } } } } }
  } } } }`, { owner, name }).repository.pullRequests;
const prs = prPage.nodes;

const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const prState = (pr) => {
  const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
  const failing = contexts.filter((c) => FAILED.has(c.conclusion ?? c.state)).map((c) => c.name ?? c.context);
  const pending = contexts.filter((c) => c.__typename === "CheckRun" ? c.status !== "COMPLETED" : c.state === "PENDING");
  const unresolved = pr.reviewThreads.nodes.filter((t) => !t.isResolved).length;
  return { failing, pending: pending.length, unresolved, checks: contexts.length };
};

// ── the plan: open issues that have sub-issues (phases), and their tasks ─────
const planQuery = (withClosers) => `query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){
  issues(states:OPEN, first:100, orderBy:{field:CREATED_AT, direction:ASC}){ pageInfo{ hasNextPage } nodes{
    number title issueType{ name }
    subIssues(first:100){ nodes{ number title state assignees(first:5){ nodes{ login } }
      ${withClosers ? "closedByPullRequestsReferences(first:3, includeClosedPrs:false){ nodes{ number } }" : ""} } }
  } } } }`;
let issues;
try { issues = graphql(planQuery(true), { owner, name }).repository.issues; }
catch { issues = graphql(planQuery(false), { owner, name }).repository.issues; }
const phases = issues.nodes.filter((i) => i.subIssues.nodes.length > 0 || i.issueType?.name === "Feature");

const blockersOpen = (n) => Number(gh(["api", `repos/${repo}/issues/${n}/dependencies/blocked_by`,
  "--jq", "[.[] | select(.state == \"open\")] | length"]).trim() || "0");
// --paginate runs --jq once per page, so emit every checkpoint (one JSON string
// per line) and take the last line, rather than asking jq for "last".
const checkpoint = (n) => {
  const found = gh(["api", `repos/${repo}/issues/${n}/comments`, "--paginate",
    "--jq", ".[] | select(.body | startswith(\"<!-- checkpoint v1 -->\")) | .body | @json"]).split("\n").filter(Boolean);
  const body = found.length ? JSON.parse(found.at(-1)) : "";
  const line = (key) => (body.match(new RegExp(`^${key}:\\s*(.*)$`, "m")) ?? [])[1] ?? null;
  return body ? { next: line("next"), blockers: line("blockers"), pr: line("pr") } : null;
};

const inReview = [], inProgress = [], ready = [];
for (const phase of phases) {
  for (const task of phase.subIssues.nodes) {
    if (task.state !== "OPEN") continue;
    const closers = task.closedByPullRequestsReferences?.nodes.map((p) => p.number) ?? [];
    const holders = task.assignees.nodes.map((a) => a.login);
    const row = { phase: phase.number, number: task.number, title: task.title, holders, closers };
    if (closers.length) inReview.push(row);
    else if (holders.length) inProgress.push(row);
    else if (blockersOpen(task.number) === 0) ready.push(row);
  }
}

// ── print ─────────────────────────────────────────────────────────────────────
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
const out = [];
out.push(`${repo} · signed in as ${me} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, "");

out.push(`PULL REQUESTS (${prs.length} open)`);
const needsMe = [], needsPerson = [];
for (const pr of prs) {
  const s = prState(pr);
  const notes = [];
  if (pr.isDraft) notes.push("draft");
  if (s.unresolved) notes.push(`${s.unresolved} unresolved thread${s.unresolved > 1 ? "s" : ""}`);
  if (s.failing.length) notes.push(`failing: ${s.failing.join(", ")}`);
  else if (s.pending) notes.push(`${s.pending} check${s.pending > 1 ? "s" : ""} running`);
  else if (s.checks) notes.push("checks passing");
  if (pr.mergeable === "CONFLICTING") notes.push("merge conflict");
  const mine = pr.author?.login === me;
  if (mine && (s.unresolved || s.failing.length || pr.mergeable === "CONFLICTING")) needsMe.push(pr.number);
  else if (mine && !pr.isDraft && !s.pending) needsPerson.push(pr.number);
  out.push(`  #${pr.number} ${cut(pr.title, 58)} ${pr.author?.login ?? "?"} · ${notes.join(" · ") || "no checks"}`);
}
if (!prs.length) out.push("  none");
if (prPage.pageInfo.hasNextPage) out.push("  (more than 100 open; only the 100 most recently updated were read)");
out.push("");

out.push("PLAN");
for (const phase of phases) {
  const all = phase.subIssues.nodes.length;
  const done = phase.subIssues.nodes.filter((t) => t.state !== "OPEN").length;
  out.push(`  #${phase.number} ${cut(phase.title, 66)} ${done}/${all} done`);
}
if (!phases.length) out.push("  no issue with sub-issues. This repository keeps its plan elsewhere; read AGENTS.md");
if (issues.pageInfo.hasNextPage) out.push("  (more than 100 open issues; only the oldest 100 were read)");
out.push("");

const withCheckpoint = (row) => {
  const cp = checkpoint(row.number);
  return cp?.next ? `\n      checkpoint: next: ${cp.next}${cp.blockers && cp.blockers !== "none" ? ` · blockers: ${cp.blockers}` : ""}` : "";
};
out.push("IN REVIEW (an open pull request will close it)");
for (const r of inReview) out.push(`  #${r.number} ${cut(r.title, 60)} PR #${r.closers.join(", #")}`);
if (!inReview.length) out.push("  none");
out.push("", "IN PROGRESS (assigned)");
for (const r of inProgress) out.push(`  #${r.number} ${cut(r.title, 60)} @${r.holders.join(", @")}${withCheckpoint(r)}`);
if (!inProgress.length) out.push("  none");
out.push("", `READY (open, unassigned, every blocker closed; first ${limit})`);
for (const r of ready.slice(0, limit)) out.push(`  #${r.number} ${cut(r.title, 60)} phase #${r.phase}${withCheckpoint(r)}`);
if (!ready.length) out.push("  none");
if (ready.length > limit) out.push(`  … and ${ready.length - limit} more`);
out.push("");

out.push("NEXT");
const mineInProgress = inProgress.filter((r) => r.holders.includes(me));
if (needsMe.length) out.push(`  Answer the review or fix the checks on PR #${needsMe.join(", #")}.`);
if (mineInProgress.length) out.push(`  Continue #${mineInProgress[0].number}, which you hold.`);
if (!needsMe.length && !mineInProgress.length) {
  out.push(ready.length ? `  Claim and start #${ready[0].number}: ${ready[0].title}` : "  Nothing is ready. Everything open is blocked, held or in review.");
}
if (needsPerson.length) out.push(`  Waiting for a person to merge or decide: PR #${needsPerson.join(", #")}.`);
console.log(out.join("\n"));
