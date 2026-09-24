#!/usr/bin/env node
// snapshot: where work stands, for a repository whose plan and state live in
// GitHub (issues, sub-issues, blocked-by links, checkpoint comments, pull
// requests). It only reads; it never changes anything. The rules it applies are
// in lib.mjs.
//
// Usage: node snapshot.mjs [--repo owner/name] [--limit 5]
// Exit codes: 0 printed, 2 GitHub could not be asked, 64 usage.
import { gh, repoFromGit, isRepo, parseArgs, listComments, triagePullRequest, closersByIssue,
         completePhase, sortTasks, nextSteps, parseCheckpoint, describeCheckpoint, CHECKPOINT } from "./lib.mjs";

process.on("uncaughtException", (err) => {
  console.error(`snapshot: GitHub could not be asked (${err.message})`);
  process.exit(2);
});

const args = parseArgs(process.argv.slice(2), { "--repo": "value", "--limit": "value" });
const repo = args.values?.repo ?? repoFromGit();
if (args.error || !isRepo(repo)) {
  console.error(`snapshot: ${args.error ?? "no repository. Run inside a clone, or pass --repo owner/name."}`);
  console.error("usage: snapshot.mjs [--repo owner/name] [--limit 5]");
  process.exit(64);
}
const [owner, name] = repo.split("/");
const limit = Math.max(1, Number(args.values.limit ?? 5) || 5);
const me = gh(["api", "user", "--jq", ".login"]).trim();

// Every page, not only the first, so nothing is judged from part of a list.
function allPages(query, pick) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const vars = { owner, name, ...(after ? { after } : {}) };
    const conn = pick(JSON.parse(gh(["api", "graphql", "-f", `query=${query}`,
      ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])])).data);
    nodes.push(...conn.nodes);
    if (!conn.pageInfo.hasNextPage) return { nodes, complete: true };
    after = conn.pageInfo.endCursor;
  }
  return { nodes, complete: false };
}

// ── pull requests, what each is waiting for, and which issues each will close ─
const prs = allPages(`query($owner:String!,$name:String!,$after:String){ repository(owner:$owner,name:$name){
  pullRequests(states:OPEN, first:50, after:$after, orderBy:{field:UPDATED_AT, direction:DESC}){
    pageInfo{ hasNextPage endCursor } nodes{
    number title isDraft author{ login } reviewDecision mergeable
    closingIssuesReferences(first:25){ nodes{ number repository{ nameWithOwner } } }
    reviewThreads(first:100){ totalCount nodes{ isResolved } }
    commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ totalCount nodes{
      __typename ... on CheckRun{ name status conclusion } ... on StatusContext{ context state } } } } } } }
  } } } }`, (d) => d.repository.pullRequests);

// ── the plan: open issues that have sub-issues (phases), and their tasks ─────
const issues = allPages(`query($owner:String!,$name:String!,$after:String){ repository(owner:$owner,name:$name){
  issues(states:OPEN, first:100, after:$after, orderBy:{field:CREATED_AT, direction:ASC}){
    pageInfo{ hasNextPage endCursor } nodes{
    number title issueType{ name }
    subIssues(first:100){ totalCount nodes{ number title state assignees(first:10){ nodes{ login } } } }
  } } } }`, (d) => d.repository.issues);
// Every sub-issue of a phase, from the REST listing, in the shape the query returns.
const readSubIssues = (n) => gh(["api", "--paginate", `repos/${repo}/issues/${n}/sub_issues`, "--jq",
  ".[] | {number, title, state: (.state | ascii_upcase), assignees: {nodes: [.assignees[] | {login}]}} | @json"])
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));
const phases = issues.nodes.filter((i) => i.subIssues.nodes.length > 0 || i.issueType?.name === "Feature")
  .map((phase) => completePhase(phase, readSubIssues));

const openBlockers = (n) => Number(gh(["api", `repos/${repo}/issues/${n}/dependencies/blocked_by`,
  "--jq", "[.[] | select(.state == \"open\")] | length"]).trim() || "0");
const { inReview, inProgress, ready } = sortTasks(phases, closersByIssue(prs.nodes, repo), openBlockers);

const latestCheckpoint = (n) => {
  const found = listComments(repo, n).filter((c) => c.body.startsWith(CHECKPOINT)).at(-1);
  return found ? describeCheckpoint(parseCheckpoint(found.body), found.at) : [];
};

// ── print ─────────────────────────────────────────────────────────────────────
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).padEnd(n);
const out = [];
out.push(`${repo} · signed in as ${me} · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`, "");

out.push(`PULL REQUESTS (${prs.nodes.length} open)`);
const needsMe = [], needsPerson = [];
for (const pr of prs.nodes) {
  const t = triagePullRequest(pr, me);
  if (t.needsMe) needsMe.push(`PR #${pr.number}: ${t.reasons.join(", ")}`);
  if (t.needsPerson) needsPerson.push(pr.number);
  out.push(`  #${pr.number} ${cut(pr.title, 58)} ${pr.author?.login ?? "?"} · ${t.notes.join(" · ")}`);
}
if (!prs.nodes.length) out.push("  none");
if (!prs.complete) out.push("  (more pull requests are open than were read)");
out.push("");

out.push("PLAN");
for (const phase of phases) {
  const all = phase.subIssues.nodes.length;
  const done = phase.subIssues.nodes.filter((t) => t.state !== "OPEN").length;
  out.push(`  #${phase.number} ${cut(phase.title, 66)} ${done}/${all} done`);
}
if (!phases.length) out.push("  no issue with sub-issues. This repository keeps its plan elsewhere; read AGENTS.md");
if (!issues.complete) out.push("  (more issues are open than were read)");
out.push("");

out.push("IN REVIEW (an open pull request will close it)");
for (const r of inReview) out.push(`  #${r.number} ${cut(r.title, 60)} PR #${r.closers.join(", #")}`);
if (!inReview.length) out.push("  none");
out.push("", "IN PROGRESS (assigned)");
for (const r of inProgress) {
  out.push(`  #${r.number} ${cut(r.title, 60)} @${r.holders.join(", @")}`);
  for (const line of latestCheckpoint(r.number)) out.push(`      ${line}`);
}
if (!inProgress.length) out.push("  none");
out.push("", `READY (open, unassigned, every blocker closed; first ${limit})`);
for (const r of ready.slice(0, limit)) {
  out.push(`  #${r.number} ${cut(r.title, 60)} phase #${r.phase}`);
  for (const line of latestCheckpoint(r.number)) out.push(`      ${line}`);
}
if (!ready.length) out.push("  none");
if (ready.length > limit) out.push(`  … and ${ready.length - limit} more`);
if (!prs.complete && ready.length) out.push("  (not every open pull request was read, so one of these may already have one)");
out.push("");

out.push("NEXT");
const held = inProgress.filter((r) => r.holders.includes(me));
for (const line of nextSteps({ needsMe, held, ready, needsPerson })) out.push(`  ${line}`);
console.log(out.join("\n"));
