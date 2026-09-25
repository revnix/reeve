#!/usr/bin/env node
// snapshot: where work stands, for a repository whose plan and state live in
// GitHub (issues, sub-issues, blocked-by links, checkpoint comments, pull
// requests). It only reads; it never changes anything. What it reads comes from
// plan.mjs, which the board reads too, and the rules it applies are in lib.mjs.
//
// Usage: node snapshot.mjs [--repo owner/name] [--limit 5]
// Exit codes: 0 printed, 2 GitHub could not be asked, 64 usage.
import { gh, repoFromGit, isRepo, parseArgs, listComments, triagePullRequest, closersByIssue,
         sortTasks, nextSteps, parseCheckpoint, describeCheckpoint, CHECKPOINT } from "./lib.mjs";
import { readPlan, openBlockers } from "./plan.mjs";

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
const limit = Math.max(1, Number(args.values.limit ?? 5) || 5);
const me = gh(["api", "user", "--jq", ".login"]).trim();
const { prs, issues, phases } = readPlan(repo);
const { inReview, inProgress, ready } = sortTasks(phases, closersByIssue(prs.nodes, repo), (n) => openBlockers(repo, n));

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
if (prs.nodes.some((pr) => pr.partial)) out.push("  (a pull request's checks or closing issues couldn't all be read)");
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
