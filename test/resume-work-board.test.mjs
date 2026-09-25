// The plan board's rules (#190).
//
// The board is a GitHub Project whose columns are computed from the issues and
// pull requests, never typed, so it can't drift. These tests check each column
// rule, and which linked project counts as the board, from plain data. The sync
// that writes the board (scripts/board.mjs) applies exactly these functions.
import { boardColumn, pickBoard, BOARD_COLUMNS, allNodes, incompleteRead, closedCards } from "../.agents/skills/resume-work/scripts/lib.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// A pull request in the shape plan.mjs reads, ready and waiting on a person.
const pr = (over = {}) => ({
  number: 1, isDraft: false, reviewDecision: null, mergeable: "MERGEABLE",
  reviewThreads: { totalCount: 0, nodes: [] },
  commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 1,
    nodes: [{ __typename: "CheckRun", name: "Test", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] },
  ...over,
});
const failing = { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 1,
  nodes: [{ __typename: "CheckRun", name: "Test", status: "COMPLETED", conclusion: "FAILURE" }] } } } }] } };

// ── the columns ───────────────────────────────────────────────────────────────
check(boardColumn({ open: false, blocked: true, closers: [pr()], assigned: true }) === "Done",
  "a closed task is Done, whatever else is true of it");
check(boardColumn({ open: true, blocked: true, closers: [pr()], assigned: true }) === "Blocked",
  "an open task with an open blocker is Blocked, even with a pull request");
check(boardColumn({ open: true, blocked: false, closers: [pr()], assigned: true }) === "In review",
  "a task whose pull request is ready and waiting on a person is In review");
check(boardColumn({ open: true, blocked: false, closers: [pr({ isDraft: true })], assigned: true }) === "In progress",
  "a task whose pull request is still a draft is In progress");
check(boardColumn({ open: true, blocked: false, closers: [pr({ reviewThreads: { totalCount: 1, nodes: [{ isResolved: false }] } })], assigned: true }) === "In progress"
  && boardColumn({ open: true, blocked: false, closers: [pr(failing)], assigned: true }) === "In progress"
  && boardColumn({ open: true, blocked: false, closers: [pr({ mergeable: "CONFLICTING" })], assigned: true }) === "In progress",
  "a task whose pull request has review findings, failing checks or a conflict is In progress");
check(boardColumn({ open: true, blocked: false, closers: [pr(), pr({ number: 2, isDraft: true })], assigned: true }) === "In progress",
  "one pull request still needing its author keeps the task In progress");
check(boardColumn({ open: true, blocked: false, closers: [], assigned: true }) === "In progress",
  "an assigned task with no pull request is In progress");
check(boardColumn({ open: true, blocked: false, closers: [], assigned: false }) === "Ready",
  "an open, unblocked, unassigned task is Ready");

// ── which linked project is the board ────────────────────────────────────────
const project = (number, names) => ({ id: `P${number}`, number, status: { id: "F", options: names.map((n) => ({ id: n, name: n })) } });
const one = pickBoard([project(1, ["Todo", "In Progress", "Done"]), project(2, BOARD_COLUMNS)]);
check(one.board?.number === 2 && one.why === null, "the linked project with the five columns is the board", JSON.stringify(one));
const none = pickBoard([project(1, ["Todo", "In Progress", "Done"]), project(3, [...BOARD_COLUMNS, "Icebox"])]);
check(none.board === null && /no linked project/.test(none.why ?? ""),
  "a project with other columns, or extra ones, is not taken for the board", JSON.stringify(none));
const two = pickBoard([project(2, BOARD_COLUMNS), project(4, [...BOARD_COLUMNS].reverse())]);
check(two.board === null && /#2, #4/.test(two.why ?? ""), "two projects that both look like the board are named, not guessed between", JSON.stringify(two));

// ── reading whole lists, and refusing to write from part of one ──────────────
{
  const pages = [[1, 2], [3, 4], [5, 6]];
  const fetch = (after) => { const i = after === null ? 0 : Number(after); return { nodes: pages[i], pageInfo: { hasNextPage: i + 1 < pages.length, endCursor: String(i + 1) } }; };
  const all = allNodes(fetch), cut = allNodes(fetch, 2);
  check(all.complete && all.nodes.length === 6 && !cut.complete && cut.nodes.length === 4,
    "every page of a connection is read, and a list cut short says so", JSON.stringify({ all, cut }));
  const why = incompleteRead({ "pull requests": { complete: false }, issues: { complete: true }, "board cards": { complete: true } });
  check(/pull requests/.test(why ?? "") && /no card was moved/.test(why ?? "") && incompleteRead({ issues: { complete: true } }) === null,
    "a list read in part stops the sync before any card moves", String(why));
}

// ── a closed task is Done, even when its phase is gone from the plan ─────────
{
  const cards = new Map([[1, { item: "a", state: "CLOSED" }], [2, { item: "b", state: "CLOSED" }], [3, { item: "c", state: "OPEN" }]]);
  const done = closedCards(cards, new Set([1]));
  check(done.length === 1 && done[0].number === 2,
    "a closed task no open phase lists any more still goes to Done", JSON.stringify(done));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
