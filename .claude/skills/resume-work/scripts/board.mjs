#!/usr/bin/env node
// board: keep the plan board in step with the issues. The board is a GitHub
// Project linked to the repository, whose Status field has the five columns in
// lib.mjs. Each task's column is computed from the same facts the snapshot reads
// (plan.mjs) and written only where it differs. The board is never read as
// state, so a card moved by hand is put back.
//
// Usage: node board.mjs [--repo owner/name]
// Exit codes: 0 synced, or no board to sync; 2 GitHub could not be asked; 64 usage.
import { gh, repoFromGit, isRepo, parseArgs, closersByIssue, boardColumn, pickBoard, BOARD_COLUMNS,
         allNodes, incompleteRead, closedCards, closedPhases, closedParent, syncClosedParents, openStrays, mustUnarchive } from "./lib.mjs";
import { readPlan, openBlockers, readSubIssues } from "./plan.mjs";

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

// Every read comes first, and the board is written only once all of them are
// whole: a list read in part would move cards the wrong way.
// ── the board: the one linked project with the five columns ──────────────────
const projects = allNodes((after) => gql(`query($owner:String!,$name:String!${after ? ",$after:String" : ""}){ repository(owner:$owner,name:$name){
  projectsV2(first:20${after ? ",after:$after" : ""}){ pageInfo{ hasNextPage endCursor } nodes{ id number title closed
    status: field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } } } } } }`,
  { owner, name, ...(after ? { after } : {}) }).repository.projectsV2, 20);
if (!projects.complete) { console.error(`board: ${incompleteRead({ "linked projects": projects })}`); process.exit(2); }
const { board, why } = pickBoard(projects.nodes);
if (!board) { console.log(`board: nothing to sync for ${repo}: ${why}`); process.exit(0); }
const optionFor = Object.fromEntries(board.status.options.map((o) => [o.name, o.id]));

// ── its cards, by issue number ───────────────────────────────────────────────
const items = allNodes((after) => gql(`query($id:ID!${after ? ",$after:String" : ""}){ node(id:$id){ ... on ProjectV2{
  items(first:100, archivedStates:[ARCHIVED, NOT_ARCHIVED]${after ? ",after:$after" : ""}){ pageInfo{ hasNextPage endCursor } nodes{ id isArchived
    content{ ... on Issue{ number state assignees(first:1){ totalCount } parent{ number } subIssues{ totalCount }
      repository{ nameWithOwner } } }
    status: fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ optionId } } } } } } }`,
  { id: board.id, ...(after ? { after } : {}) }).node.items);
const cards = new Map();
for (const it of items.nodes) {
  if (it.content?.repository?.nameWithOwner?.toLowerCase() === repo.toLowerCase())
    cards.set(it.content.number, { item: it.id, archived: it.isArchived === true, option: it.status?.optionId ?? null, state: it.content.state,
                                   assigned: (it.content.assignees?.totalCount ?? 0) > 0,
                                   parent: it.content.parent?.number ?? null, phase: (it.content.subIssues?.totalCount ?? 0) > 0 });
}

// ── the plan ─────────────────────────────────────────────────────────────────
const { prs, issues, phases } = readPlan(repo);
const partial = incompleteRead({ "pull requests": prs, "pull requests' checks and closing issues": { complete: !prs.nodes.some((pr) => pr.partial) },
                                "issues": issues, "board cards": items });
if (partial) { console.error(`board: ${partial}`); process.exit(2); }

// An issue's card, added if it has none. Adding one that exists returns it, as
// it was, archived or not.
const cardFor = (issue) => {
  const known = cards.get(issue.number);
  if (known) return { id: known.item, archived: known.archived };
  const item = gql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item{ id isArchived } } }`,
    { p: board.id, c: issue.id }).addProjectV2ItemById.item;
  return { id: item.id, archived: item.isArchived === true };
};
const unarchive = (item) => gql(`mutation($p:ID!,$i:ID!){ unarchiveProjectV2Item(input:{projectId:$p,itemId:$i}){ item{ id } } }`,
  { p: board.id, i: item });

// ── every phase's tasks, each set to its computed column ─────────────────────
const prByNumber = new Map(prs.nodes.map((pr) => [pr.number, pr]));
const closers = closersByIssue(prs.nodes, repo);
const counts = Object.fromEntries(BOARD_COLUMNS.map((c) => [c, 0]));
let moved = 0;
const visited = new Set();
const setColumn = (item, column) => gql(`mutation($p:ID!,$i:ID!,$f:ID!,$v:String!){ updateProjectV2ItemFieldValue(input:{
  projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$v}}){ projectV2Item{ id } } }`,
{ p: board.id, i: item, f: board.status.id, v: optionFor[column] });
// Closed issues with sub-issues, whose sub-issues the plan doesn't read: those
// on the board, and any closed task with sub-tasks met while syncing.
const parents = new Map(closedPhases(cards).map((c) => [c.number, c]));
// One task: its column from its own facts, and its card added if it has none.
const syncTask = (task, item = null) => {
  visited.add(task.number);
  if (closedParent(task) && !parents.has(task.number)) parents.set(task.number, task);
  const open = task.state === "OPEN";
  const column = boardColumn({
    open,
    blocked: open && openBlockers(repo, task.number) > 0,
    closers: (closers.get(task.number) ?? []).map((n) => prByNumber.get(n)).filter(Boolean),
    assigned: task.assigned ?? task.assignees.nodes.length > 0,
  });
  counts[column]++;
  const card = item ? { id: item, archived: cards.get(task.number)?.archived } : cardFor(task);
  // Archived by hand or by an auto-archive, an active task would stay hidden
  // whatever its column says.
  if (mustUnarchive({ archived: card.archived, column })) { unarchive(card.id); moved++; }
  if (cards.get(task.number)?.option === optionFor[column]) return;
  setColumn(card.id, column);
  moved++;
};
for (const phase of phases) {
  cardFor(phase);   // phases are on the project too, and the Board view filters them out
  visited.add(phase.number);
  for (const task of phase.subIssues.nodes) syncTask(task);
}
// A closed phase, or a closed task with sub-tasks, is no longer in the plan.
// Its sub-issues are read from it and synced the same way, so one left open, or
// reopened, still moves, and one closed without a card gets one, in Done. A
// closed task with sub-tasks met along the way, card or no card, is read in its
// turn. The parents' own cards are closed, and go to Done below.
syncClosedParents(parents, (n) => readSubIssues(repo, n), visited, syncTask);
// An open sub-issue whose phase isn't on the board at all is set from its own
// issue too. A card for an issue that is no sub-issue is no task, and is left.
for (const card of openStrays(cards, visited)) syncTask({ number: card.number, state: "OPEN", assigned: card.assigned }, card.item);
// A closed card none of that reached is Done too.
for (const card of closedCards(cards, visited)) {
  if (card.option === optionFor.Done) continue;
  setColumn(card.item, "Done");
  moved++;
}
console.log(`board: project #${board.number} synced for ${repo}; ${moved} card${moved === 1 ? "" : "s"} moved. ` +
  BOARD_COLUMNS.map((c) => `${c} ${counts[c]}`).join(", "));
