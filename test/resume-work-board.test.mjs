// The plan board's rules (#190).
//
// The board is a GitHub Project whose columns are computed from the issues and
// pull requests, never typed, so it can't drift. These tests check each column
// rule, and which linked project counts as the board, from plain data. The sync
// that writes the board (scripts/board.mjs) applies exactly these functions.
import { boardColumn, pickBoard, BOARD_COLUMNS, allNodes, incompleteRead, closedCards, closedPhases, closedParent, syncClosedParents, openStrays, mustUnarchive, closersByIssue, completePullRequest, triagePullRequest } from "../.agents/skills/resume-work/scripts/lib.mjs";
import { readPlan, openBlockers } from "../.agents/skills/resume-work/scripts/plan.mjs";

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
{
  // Just after a push, the checks are queued or running: nobody can act yet.
  const running = { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 1,
    nodes: [{ __typename: "CheckRun", name: "Test", status: "IN_PROGRESS", conclusion: null }] } } } }] } };
  check(boardColumn({ open: true, blocked: false, closers: [pr(running)], assigned: true }) === "In progress",
    "a task whose pull request's checks are still running is In progress, not yet In review");
}
check(boardColumn({ open: true, blocked: false, closers: [], assigned: true }) === "In progress",
  "an assigned task with no pull request is In progress");
check(boardColumn({ open: true, blocked: false, closers: [], assigned: false }) === "Ready",
  "an open, unblocked, unassigned task is Ready");

// ── which linked project is the board ────────────────────────────────────────
const project = (number, names) => ({ id: `P${number}`, number, status: { id: "F", options: names.map((n) => ({ id: n, name: n })) } });
const one = pickBoard([project(1, ["Todo", "In Progress", "Done"]), project(2, BOARD_COLUMNS)]);
check(one.board?.number === 2 && one.why === null, "the linked project with the five columns is the board", JSON.stringify(one));
const none = pickBoard([project(1, ["Todo", "In Progress", "Done"]), project(3, [...BOARD_COLUMNS, "Icebox"])]);
check(none.board === null && /no open linked project/.test(none.why ?? ""),
  "a project with other columns, or extra ones, is not taken for the board", JSON.stringify(none));
const two = pickBoard([project(2, BOARD_COLUMNS), project(4, [...BOARD_COLUMNS].reverse())]);
check(two.board === null && /#2, #4/.test(two.why ?? ""), "two projects that both look like the board are named, not guessed between", JSON.stringify(two));
{
  // An old project kept, closed, with the same five columns.
  const closed = (number) => ({ ...project(number, BOARD_COLUMNS), closed: true });
  const beside = pickBoard([closed(1), project(2, BOARD_COLUMNS)]);
  const alone = pickBoard([closed(1)]);
  check(beside.board?.number === 2 && alone.board === null && /no open linked project/.test(alone.why ?? ""),
    "a closed project is never the board, beside the open one or alone", JSON.stringify({ beside, alone }));
}

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

// ── a pull request's own lists, and a task's blockers, read whole ───────────
//
// The query that reads the pull requests stops each one's lists at their first
// page. A fake GitHub answers as the real one pages: the checks at the head run
// to a second page with a failing check on it, and the issues the pull request
// will close run to a second page too.
{
  const check_ = (name, conclusion) => ({ __typename: "CheckRun", name, status: "COMPLETED", conclusion });
  const firstChecks = Array.from({ length: 100 }, (_, i) => check_(`job ${i}`, "SUCCESS"));
  const run = (args) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    const vars = Object.fromEntries(args.filter((a) => /^\w+=/.test(a) && !a.startsWith("query=")).map((a) => a.split(/=(.*)/s).slice(0, 2)));
    const page = (nodes, next) => ({ totalCount: 0, pageInfo: { hasNextPage: Boolean(next), endCursor: next ?? null }, nodes });
    if (query.includes("pullRequest(number:$n)")) {
      const pr = query.includes("closingIssuesReferences")
        ? { closingIssuesReferences: vars.after === "c1" ? page([{ number: 11, repository: { nameWithOwner: "o/r" } }], null) : page([], null) }
        : { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: vars.after === "k1" ? page([check_("Lint", "FAILURE")], null) : page([], null) } } }] } };
      return JSON.stringify({ data: { repository: { pullRequest: pr } } });
    }
    if (query.includes("pullRequests(")) return JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      number: 7, title: "t", isDraft: false, author: { login: "a" }, reviewDecision: null, mergeable: "MERGEABLE",
      closingIssuesReferences: { totalCount: 2, pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [{ number: 10, repository: { nameWithOwner: "o/r" } }] },
      reviewThreads: { totalCount: 0, nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: "k1" }, nodes: firstChecks } } } }] } }] } } } });
    if (query.includes("issues(")) return JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    return "";
  };
  const plan = readPlan("o/r", run);
  const [only] = plan.prs.nodes;
  const closers = closersByIssue(plan.prs.nodes, "o/r");
  check(closers.get(10)?.includes(7) && closers.get(11)?.includes(7),
    "every issue a pull request will close is read, past the first page, so neither task looks ready", JSON.stringify([...closers]));
  // Seen, not only unread: a check left unread keeps a task out of In review on
  // its own, so the failing check itself must be among the reasons.
  const reasons = triagePullRequest(only, null).reasons;
  check(boardColumn({ open: true, blocked: false, closers: [only], assigned: true }) === "In progress" && only.partial === false
    && reasons.some((r) => /failing: .*\bLint\b/.test(r)),
    "every check at its head is read, so a failing one past the first page keeps its task In progress",
    JSON.stringify({ partial: only.partial, read: only.commits.nodes[0].commit.statusCheckRollup.contexts.nodes.length, reasons }));
  const more = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "x" } };   // a list whose pages never end
  const endless = completePullRequest({ ...only, closingIssuesReferences: more }, () => more, 3);
  check(endless.partial === true && /no card was moved/.test(incompleteRead({ "pull requests' checks and closing issues": { complete: !endless.partial } }) ?? ""),
    "a pull request whose lists still couldn't be read whole is partial, and the board moves no card from it", JSON.stringify({ partial: endless.partial }));
}
{
  // Review threads run past their first page too: 100 resolved on the first,
  // and on the second one more, resolved or not.
  const planWith = (lastResolved) => readPlan("o/r", (args) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    const after = (args.find((a) => a.startsWith("after=")) ?? "").slice(6);
    if (query.includes("pullRequest(number:$n)"))
      return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: after === "t1"
        ? { totalCount: 101, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ isResolved: lastResolved }] }
        : { totalCount: 101, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
    if (query.includes("pullRequests(")) return JSON.stringify({ data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
      number: 8, title: "t", isDraft: false, author: { login: "a" }, reviewDecision: null, mergeable: "MERGEABLE",
      closingIssuesReferences: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 12, repository: { nameWithOwner: "o/r" } }] },
      reviewThreads: { totalCount: 101, pageInfo: { hasNextPage: true, endCursor: "t1" }, nodes: Array.from({ length: 100 }, () => ({ isResolved: true })) },
      commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [{ __typename: "CheckRun", name: "Test", status: "COMPLETED", conclusion: "SUCCESS" }] } } } }] } }] } } } });
    if (query.includes("issues(")) return JSON.stringify({ data: { repository: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } });
    return "";
  });
  const resolved = planWith(true).prs.nodes[0], open = planWith(false).prs.nodes[0];
  check(boardColumn({ open: true, blocked: false, closers: [resolved], assigned: true }) === "In review"
    && boardColumn({ open: true, blocked: false, closers: [open], assigned: true }) === "In progress" && !resolved.partial,
    "every review thread is read past the first page: all resolved reaches In review, and one open on a later page keeps it In progress",
    JSON.stringify({ read: resolved.reviewThreads.nodes.length, partial: resolved.partial }));
}
{
  // Cards the plan didn't visit: a closed phase, a task under it left open, and
  // an open issue that is no one's sub-issue.
  const cards = new Map([
    [10, { item: "p", state: "CLOSED", phase: true, parent: null }],
    [1, { item: "a", state: "OPEN", assigned: true, parent: 10 }],
    [2, { item: "b", state: "CLOSED", parent: 10 }],
    [3, { item: "c", state: "OPEN", parent: 10 }],
    [4, { item: "d", state: "OPEN", assigned: true, parent: null }],
  ]);
  const visited = new Set([3]);
  const phases = closedPhases(cards, visited), strays = openStrays(cards, visited);
  check(phases.length === 1 && phases[0].number === 10,
    "a closed phase on the board is read, so its tasks are synced, and one without a card gets one", JSON.stringify(phases));
  // A task closed with sub-tasks of its own, inside an open phase: the phase's
  // loop has already visited it, and its sub-tasks still need reading.
  const nested = closedPhases(new Map([[20, { item: "t", state: "CLOSED", phase: true, parent: 148 }]]), new Set([20]));
  check(nested.length === 1 && nested[0].number === 20,
    "a closed task with sub-tasks of its own is read even after its open phase visited it", JSON.stringify(nested));
  check(strays.length === 1 && strays[0].number === 1 && strays[0].assigned === true
    && boardColumn({ open: true, blocked: false, closers: [], assigned: strays[0].assigned }) === "In progress",
    "an open task no open phase lists is still set from its own issue", JSON.stringify(strays));
  check(!strays.some((c) => c.number === 4), "and an open card that is no one's sub-issue is no task, and is left as it is", JSON.stringify(strays));
}
{
  // A task's blockers, two pages of them, an open one on each.
  const pages = [[{ number: 5, state: "open" }, { number: 6, state: "closed" }], [{ number: 9, state: "open" }]];
  const seen = [];
  const run = (args) => {
    seen.push(args);
    const open = (list) => list.filter((b) => b.state === "open");
    // What gh prints: every page with --paginate, the first page without it.
    if (args.includes("--paginate")) return pages.flatMap(open).map((b) => b.number).join("\n") + "\n";
    return String(open(pages[0]).length);
  };
  const n = openBlockers("o/r", 3, run);
  check(n === 2 && seen.every((a) => a.includes("--paginate")), "a task's open blockers are counted from every page", JSON.stringify({ n, seen }));
}

// ── closed parents found while syncing ──────────────────────────────────────
{
  // Phase 10 is closed and on the board. Under it, task 20 closed with sub-tasks
  // of its own and has no card, and under that, task 30 is still open.
  const subIssues = { 10: [{ number: 20, state: "CLOSED", subIssues: { totalCount: 1 } }], 20: [{ number: 30, state: "OPEN", subIssues: { totalCount: 0 } }] };
  const parents = new Map([[10, { number: 10 }]]), visited = new Set(), synced = [];
  const syncTask = (task) => { visited.add(task.number); synced.push(task.number); if (closedParent(task) && !parents.has(task.number)) parents.set(task.number, task); };
  syncClosedParents(parents, (n) => subIssues[n] ?? [], visited, syncTask);
  check(synced.join(",") === "20,30",
    "a closed task with sub-tasks met while syncing is read in its turn, card or no card, however deep", JSON.stringify(synced));
}

// ── an archived card ─────────────────────────────────────────────────────────
check(mustUnarchive({ archived: true, column: "In progress" }) && mustUnarchive({ archived: true, column: "Ready" })
  && !mustUnarchive({ archived: true, column: "Done" }) && !mustUnarchive({ archived: false, column: "In progress" }),
  "an active task's archived card comes back before its column is set, and a finished one stays archived");

// ── a closed task is Done, even when its phase is gone from the plan ─────────
{
  const cards = new Map([[1, { item: "a", state: "CLOSED", parent: 9 }], [2, { item: "b", state: "CLOSED", parent: 9 }], [3, { item: "c", state: "OPEN", parent: 9 }],
    [4, { item: "d", state: "CLOSED", parent: null, phase: false }], [9, { item: "p", state: "CLOSED", parent: null, phase: true }]]);
  const done = closedCards(cards, new Set([1]));
  check(done.some((c) => c.number === 2) && done.some((c) => c.number === 9) && !done.some((c) => c.number === 1 || c.number === 3),
    "a closed task no open phase lists any more still goes to Done", JSON.stringify(done));
  check(!done.some((c) => c.number === 4),
    "and a closed issue on the board for another reason, no sub-issue and no phase, is left as it is", JSON.stringify(done));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
