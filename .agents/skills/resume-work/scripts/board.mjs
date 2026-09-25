#!/usr/bin/env node
// board: keep the plan board in step with the issues. The board is a GitHub
// Project linked to the repository, whose Status field has the five columns in
// lib.mjs. Each task's column is computed from the same facts the snapshot reads
// (plan.mjs) and written only where it differs. The board is never read as
// state, so a card moved by hand is put back.
//
// Usage: node board.mjs [--repo owner/name]
// Exit codes: 0 synced, or no board to sync; 2 GitHub could not be asked; 64 usage.
import { gh, repoFromGit, isRepo, parseArgs, closersByIssue, boardColumn, pickBoard, BOARD_COLUMNS } from "./lib.mjs";
import { readPlan, openBlockers } from "./plan.mjs";

process.on("uncaughtException", (err) => {
  console.error(`board: GitHub could not be asked (${err.message})`);
  if (/scope/i.test(err.message)) console.error("-> gh auth refresh -s project   grants the scope a project needs");
  process.exit(2);
});

const args = parseArgs(process.argv.slice(2), { "--repo": "value" });
const repo = args.values?.repo ?? repoFromGit();
if (args.error || !isRepo(repo)) {
  console.error(`board: ${args.error ?? "no repository. Run inside a clone, or pass --repo owner/name."}`);
  console.error("usage: board.mjs [--repo owner/name]");
  process.exit(64);
}
const [owner, name] = repo.split("/");

// Reads retry. The writes below are idempotent, so they retry too: adding a card
// that exists returns it, and setting a column twice sets it once.
const gql = (query, vars = {}) => {
  const out = JSON.parse(gh(["api", "graphql", "-f", `query=${query}`,
    ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])]));
  if (out.errors?.length) throw new Error(out.errors.map((e) => e.message).join("; "));
  return out.data;
};

// ── the board: the one linked project with the five columns ──────────────────
const linked = gql(`query($owner:String!,$name:String!){ repository(owner:$owner,name:$name){
  projectsV2(first:20){ nodes{ id number title
    status: field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } } } } } }`,
  { owner, name }).repository.projectsV2.nodes;
const { board, why } = pickBoard(linked);
if (!board) { console.log(`board: nothing to sync for ${repo}: ${why}`); process.exit(0); }
const optionFor = Object.fromEntries(board.status.options.map((o) => [o.name, o.id]));

// ── its cards, by issue number ───────────────────────────────────────────────
const cards = new Map();
for (let after = null, page = 0; page < 50; page++) {
  const items = gql(`query($id:ID!${after ? ",$after:String" : ""}){ node(id:$id){ ... on ProjectV2{
    items(first:100${after ? ",after:$after" : ""}){ pageInfo{ hasNextPage endCursor } nodes{ id
      content{ ... on Issue{ number repository{ nameWithOwner } } }
      status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } } } } } } }`,
  { id: board.id, ...(after ? { after } : {}) }).node.items;
  for (const it of items.nodes) {
    if (it.content?.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase())
      cards.set(it.content.number, { item: it.id, option: it.status?.optionId ?? null });
  }
  if (!items.pageInfo.hasNextPage) break;
  after = items.pageInfo.endCursor;
}
const cardFor = (issue) => cards.get(issue.number)?.item ?? gql(`mutation($p:ID!,$c:ID!){
  addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id } } }`, { p: board.id, c: issue.id }).addProjectV2ItemById.item.id;

// ── every phase's tasks, each set to its computed column ─────────────────────
const { prs, phases } = readPlan(repo);
const prByNumber = new Map(prs.nodes.map((pr) => [pr.number, pr]));
const closers = closersByIssue(prs.nodes, repo);
const counts = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, 0]));
let moved = 0;
for (const phase of phases) {
  cardFor(phase);   // phases are on the project too, and the Board view filters them out
  for (const task of phase.subIssues.nodes) {
    const open = task.state === "OPEN";
    const column = boardColumn({
      open,
      blocked: open && openBlockers(repo, task.number) > 0,
      closers: (closers.get(task.number) ?? []).map((n) => prByNumber.get(n)).filter(Boolean),
      assigned: task.assignees.nodes.length > 0,
    });
    counts[column]++;
    const item = cardFor(task);
    if (cards.get(task.number)?.option === optionFor[column]) continue;
    gql(`mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){ updateProjectV2ItemFieldValue(input:{
      projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}){ projectV2Item{ id } } }`,
    { p: board.id, i: item, f: board.status.id, v: optionFor[column] });
    moved++;
  }
}
if (!prs.complete) console.log("board: more pull requests are open than were read, so a card may sit one column early");
console.log(`board: project #${board.number} synced for ${repo}; ${moved} card${moved === 1 ? "" : "s"} moved. ` +
  BOARD_COLUMNS.map((c) => `${c} ${counts[c]}`).join(", "));
