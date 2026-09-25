// Shared by snapshot.mjs, claim.mjs and checkpoint.mjs.
//
// The rules live here, and each one takes what GitHub or git returned and
// decides. The scripts fetch and print. So the rules can be tested without a
// network; the Reeve repository tests them in test/resume-work.test.mjs.
// Only `gh`, `repoFromGit` and the default `run` of `listComments` and
// `postComment` start processes.
import { execFileSync } from "node:child_process";

export const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Run gh. A read is retried when the connection drops, but an answer that won't
// change (a 4xx other than 429, or a GraphQL error) is not. A write that isn't
// safe to repeat passes `once` and is tried a single time: see postComment.
export function gh(args, { once = false } = {}) {
  const tries = once ? 1 : 6;
  let last = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      last = err;
      const why = String(err.stderr ?? "");
      if ((/HTTP 4\d\d/.test(why) && !/HTTP 429/.test(why)) || /GraphQL:/.test(why)) break;
      if (attempt < tries) pause(2500 * attempt);
    }
  }
  throw new Error(String(last?.stderr ?? last?.message ?? "").trim().split("\n")[0]);
}

export function repoFromGit() {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}
export const isRepo = (s) => typeof s === "string" && /^[^/\s]+\/[^/\s]+$/.test(s);

// ── arguments ────────────────────────────────────────────────────────────────
// `spec` maps each accepted flag to "value" or "switch". Anything else is refused,
// so a misspelled flag (`--relase`) can't fall through to the other operation.
export function parseArgs(argv, spec) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const kind = Object.hasOwn(spec, flag) ? spec[flag] : null;
    if (!kind) return { error: `unknown argument: ${flag}` };
    const key = flag.replace(/^--/, "");
    if (Object.hasOwn(values, key)) return { error: `${flag} is given twice` };
    if (kind === "switch") { values[key] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
    values[key] = value;
    i++;
  }
  return { values };
}

// ── comments ─────────────────────────────────────────────────────────────────
// Every comment on an issue, oldest first, as { id, body, who, at }. --paginate
// runs --jq once per page, so each comment comes back as one JSON line.
export function listComments(repo, issue, run = gh) {
  return run(["api", "--paginate", `repos/${repo}/issues/${issue}/comments`,
    "--jq", ".[] | {id, body, who: .user.login, at: .created_at} | @json"])
    .split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .map((c) => ({ ...c, body: (c.body ?? "").replace(/\r\n/g, "\n") }));
}

// Try a write that isn't safe to repeat. After a failure, ask whether it landed
// before trying again, because a request whose response was lost may still have
// been delivered.
export function postOnce(post, delivered, { attempts = 4, wait = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { post(); return; }
    catch (err) {
      wait(attempt);
      if (delivered()) return;
      if (attempt >= attempts) throw err;
    }
  }
}

// Post a comment exactly once. The POST goes to gh with `once`, because gh's own
// retry would resend it without looking.
export function postComment(repo, issue, body, { run = gh, wait = (n) => pause(1500 * n) } = {}) {
  postOnce(
    () => run(["api", `repos/${repo}/issues/${issue}/comments`, "--method", "POST", "-f", `body=${body}`, "--silent"],
      { once: true }),
    () => listComments(repo, issue, run).some((c) => c.body === body),
    { wait });
}

// ── checks ───────────────────────────────────────────────────────────────────
// A check passes only when it says so: SUCCESS, NEUTRAL or SKIPPED. FAILED lists
// the terminal failures. STALE is among them, because a stale run never
// completes, so waiting for it would wait for ever. Anything else is unfinished,
// including a state this list doesn't know, such as EXPECTED on a legacy status.
// This is the same rule as checkState in Reeve's src/premerge.mjs.
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED",
                        "ERROR", "STARTUP_FAILURE", "STALE"]);
export function classifyChecks(contexts) {
  const runs = contexts?.nodes ?? [];
  const state = (c) => String(c.conclusion ?? c.state ?? "").toUpperCase();
  return {
    total: Math.max(contexts?.totalCount ?? 0, runs.length),
    read: runs.length,
    failing: runs.filter((c) => FAILED.has(state(c))).map((c) => c.name ?? c.context ?? "?"),
    unfinished: runs.filter((c) => !FAILED.has(state(c)) && !PASSED.has(state(c))).length,
  };
}

// ── pull requests ────────────────────────────────────────────────────────────
// What a pull request is waiting for, and whose move it is. `reasons` are what
// its author has to do: answer a review, fix a check, resolve a conflict.
export function triagePullRequest(pr, me) {
  const checks = classifyChecks(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts);
  const threads = pr.reviewThreads?.nodes ?? [];
  const threadTotal = Math.max(pr.reviewThreads?.totalCount ?? 0, threads.length);
  const unresolved = threads.filter((t) => !t.isResolved).length;
  const reasons = [];
  // A draft is unfinished work, so it stays its author's move.
  if (pr.isDraft) reasons.push("still a draft");
  if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes requested");
  if (unresolved) reasons.push(`${unresolved} unresolved thread${unresolved > 1 ? "s" : ""}`);
  // An unresolved thread may be on a page that wasn't read.
  if (threadTotal > threads.length) reasons.push(`only ${threads.length} of ${threadTotal} review threads read`);
  if (checks.failing.length) reasons.push(`failing: ${checks.failing.join(", ")}`);
  if (pr.mergeable === "CONFLICTING") reasons.push("merge conflict");

  const notes = [...reasons];
  // Checks are "passing" only when every one was read and every one passed.
  const settled = !checks.failing.length && !checks.unfinished && checks.read === checks.total;
  if (checks.unfinished) notes.push(`${checks.unfinished} check${checks.unfinished > 1 ? "s" : ""} not finished`);
  if (checks.read < checks.total) notes.push(`only ${checks.read} of ${checks.total} checks read`);
  if (settled) notes.push(checks.total ? "checks passing" : "no checks");

  const mine = pr.author?.login === me;
  return {
    notes,
    reasons,
    settled,
    needsMe: mine && reasons.length > 0,
    needsPerson: mine && reasons.length === 0 && settled && !pr.isDraft,
  };
}

/**
 * A pull request with its own lists read whole: the issues it will close, its
 * review threads, and the checks at its head. The query that reads the pull
 * requests stops each at its first page, and a closing reference, an unresolved
 * thread or a failing check on a later page would otherwise go unseen.
 * `readPage(field, after)` returns the next page of `closing`, `threads` or
 * `contexts` as a connection. `partial` is true when a list still couldn't be
 * read whole, so nothing is judged from part of one.
 */
export function completePullRequest(pr, readPage, limit = 20) {
  const whole = (conn, field) => {
    if (!conn?.pageInfo?.hasNextPage) return { conn, complete: true };
    const nodes = [...conn.nodes];
    let after = conn.pageInfo.endCursor;
    for (let page = 0; page < limit; page++) {
      const next = readPage(field, after);
      nodes.push(...(next?.nodes ?? []));
      if (!next?.pageInfo) break;
      if (!next.pageInfo.hasNextPage) return { conn: { ...conn, nodes, pageInfo: next.pageInfo }, complete: true };
      after = next.pageInfo.endCursor;
    }
    return { conn: { ...conn, nodes }, complete: false };
  };
  const closing = whole(pr.closingIssuesReferences, "closing");
  const threads = whole(pr.reviewThreads, "threads");
  const commit = pr.commits?.nodes?.[0]?.commit;
  const contexts = whole(commit?.statusCheckRollup?.contexts, "contexts");
  const commits = contexts.conn === commit?.statusCheckRollup?.contexts ? pr.commits
    : { ...pr.commits, nodes: [{ ...pr.commits.nodes[0], commit: { ...commit, statusCheckRollup: { ...commit.statusCheckRollup, contexts: contexts.conn } } }] };
  return { ...pr, closingIssuesReferences: closing.conn, reviewThreads: threads.conn, commits,
           partial: !(closing.complete && threads.complete && contexts.complete) };
}

// The open pull requests that will close each issue. This reads the pull
// requests' own closingIssuesReferences, which arrive in the same query as the
// pull requests. So a task can't look ready just because a second query failed.
export function closersByIssue(prs, repo) {
  const closers = new Map();
  for (const pr of prs) {
    for (const ref of pr.closingIssuesReferences?.nodes ?? []) {
      if (ref.repository && ref.repository.nameWithOwner.toLowerCase() !== repo.toLowerCase()) continue;
      closers.set(ref.number, [...(closers.get(ref.number) ?? []), pr.number]);
    }
  }
  return closers;
}

// A phase whose sub-issues run past the first page, completed from
// `readAll(number)`. Otherwise its later tasks would vanish from every section.
export function completePhase(phase, readAll) {
  const nodes = phase.subIssues.nodes;
  if ((phase.subIssues.totalCount ?? nodes.length) <= nodes.length) return phase;
  return { ...phase, subIssues: { totalCount: phase.subIssues.totalCount, nodes: readAll(phase.number) } };
}

// Sort the plan's open tasks. In review: an open pull request will close it.
// In progress: someone is assigned. Ready: nobody is assigned, and every blocker
// is closed. `openBlockers(n)` counts task n's open blockers.
export function sortTasks(phases, closers, openBlockers) {
  const inReview = [], inProgress = [], ready = [];
  for (const phase of phases) {
    for (const task of phase.subIssues.nodes) {
      if (task.state !== "OPEN") continue;
      const row = { phase: phase.number, number: task.number, title: task.title,
                    holders: task.assignees.nodes.map((a) => a.login),
                    closers: closers.get(task.number) ?? [] };
      if (row.closers.length) inReview.push(row);
      else if (row.holders.length) inProgress.push(row);
      else if (openBlockers(task.number) === 0) ready.push(row);
    }
  }
  return { inReview, inProgress, ready };
}

// What to do next, in the order AGENTS.md gives: your pull requests first, then
// the task you hold, then a new one. A lower item is suggested only when nothing
// above it needs you, so the snapshot never offers two next steps at once.
export function nextSteps({ needsMe, held, ready, needsPerson }) {
  const lines = [];
  if (needsMe.length) lines.push(...needsMe.map((line) => `Your ${line}.`));
  else if (held.length) lines.push(`Continue #${held[0].number}, which you hold.`);
  else if (ready.length) lines.push(`Claim and start #${ready[0].number}: ${ready[0].title}`);
  else lines.push("Nothing is ready. Everything open is blocked, held or in review.");
  if (needsPerson.length) lines.push(`Waiting for a person to merge or decide: PR #${needsPerson.join(", #")}.`);
  return lines;
}

// ── checkpoints ──────────────────────────────────────────────────────────────
export const CHECKPOINT = "<!-- checkpoint v1 -->";
const FIELDS = ["branch", "head", "pr", "done", "remaining", "validation", "blockers", "next"];
const LABEL = 13;
const field = (key, value, indent = "") => {
  const [first, ...rest] = String(value).split("\n");
  return [`${indent}${`${key}:`.padEnd(LABEL)}${first}`, ...rest.map((l) => `${indent}${" ".repeat(LABEL)}${l}`)];
};

// The comment checkpoint.mjs posts. A value's later lines are indented, so none of
// them can be read as a field of its own.
export function formatCheckpoint(fields) {
  return [CHECKPOINT, ...FIELDS.filter((k) => fields[k] != null).flatMap((k) => field(k, fields[k]))].join("\n");
}

export function parseCheckpoint(body) {
  if (typeof body !== "string" || !body.startsWith(CHECKPOINT)) return null;
  const cp = {};
  let key = null;
  for (const line of body.replace(/\r\n/g, "\n").split("\n").slice(1)) {
    const m = line.match(/^([a-z]+):\s*(.*)$/);
    if (m && FIELDS.includes(m[1])) { key = m[1]; cp[key] = m[2]; }
    else if (key && line.trim()) cp[key] += `\n${line.trim()}`;
  }
  return cp;
}

// What a new session needs from a checkpoint: where the work is, and every field
// that was recorded. An optional field that is missing hides nothing else.
export function describeCheckpoint(cp, at = null) {
  if (!cp) return [];
  const where = [cp.branch && `branch ${cp.branch}${cp.head ? ` @ ${cp.head}` : ""}`, cp.pr && `PR ${cp.pr}`]
    .filter(Boolean).join(" · ");
  const when = at ? ` ${at.slice(0, 16).replace("T", " ")} UTC` : "";
  return [`checkpoint${when}${where ? `: ${where}` : ""}`,
          ...["done", "remaining", "validation", "blockers", "next"]
            .filter((k) => cp[k] != null).flatMap((k) => field(k, cp[k], "  "))];
}

// Stash entries made on a branch. `git stash list --format=%gs` names the branch:
// "WIP on <branch>: …" for a plain stash, "On <branch>: …" for one with a message.
// Work in the stash stays on this machine, so a checkpoint can't point at it.
export function stashedOn(branch, subjects) {
  return subjects.filter((s) => s.startsWith(`WIP on ${branch}:`) || s.startsWith(`On ${branch}:`));
}

// ── claims ───────────────────────────────────────────────────────────────────
export const CLAIM = "<!-- claim v1 ";
export const RELEASE = "<!-- release v1 -->";

// Whether the comment at index i is followed by a release from `who`. A release
// ends its author's own claims only, so nobody can end someone else's.
const releasedAfter = (comments, i, who) =>
  comments.slice(i + 1).some((r) => r.body.startsWith(RELEASE) && r.who === who);

// Who holds a task, from its comments (oldest first, as listComments returns
// them) and its assignees just after this session claimed it.
//
// The earliest live claim wins. A claim is live while its author is still
// assigned and hasn't released the task since. Without the assignment test, a
// claim whose author was unassigned by hand, with no release posted, would beat
// every later claim for good.
//
// A loser under the winner's account keeps the assignment, which the two share.
// A loser under another account gives its assignment up, so it doesn't look like
// it holds the task. The same applies when no claim could be confirmed at all.
export function claimOutcome(comments, { session, me, assignees }) {
  const winner = comments.find((c, i) =>
    c.body.startsWith(CLAIM) && assignees.includes(c.who) && !releasedAfter(comments, i, c.who)) ?? null;
  const winnerSession = winner?.body.match(/session=([0-9a-f]+)/)?.[1] ?? null;
  const won = winnerSession === session;
  return {
    won,
    winnerSession,
    winnerLogin: winner?.who ?? null,
    mine: comments.find((c) => c.body.startsWith(`${CLAIM}session=${session} -->`)) ?? null,
    unassign: !won && winner?.who !== me,
  };
}

// Whether `me` has a claim it hasn't released. A release is two writes, the
// assignment and this marker, and --release checks each before making it. So
// running it again finishes a release that stopped halfway.
export function unreleasedClaim(comments, me) {
  return comments.some((c, i) => c.body.startsWith(CLAIM) && c.who === me && !releasedAfter(comments, i, me));
}

// ── the plan board ───────────────────────────────────────────────────────────
// A GitHub Project linked to the repository, whose Status field has these five
// columns. Every card's column is computed from the issues and pull requests.
// The board is never read as state, so a card moved by hand is put back.
export const BOARD_COLUMNS = ["Blocked", "Ready", "In progress", "In review", "Done"];

/**
 * The column a task belongs in. `closers` are the open pull requests that will
 * close it, in the shape readPlan returns. One that needs its author (a draft,
 * review findings, changes requested, failing checks, a conflict), or whose
 * checks are still running, means the work is still being done: In progress.
 * Otherwise it waits on a person: In review.
 */
export function boardColumn({ open, blocked, closers = [], assigned }) {
  if (!open) return "Done";
  if (blocked) return "Blocked";
  if (closers.length) return closers.every((pr) => { const t = triagePullRequest(pr, null); return !t.reasons.length && t.settled; })
    ? "In review" : "In progress";
  if (assigned) return "In progress";
  return "Ready";
}

/**
 * The plan board among the projects linked to a repository: the one whose Status
 * field has exactly the five columns. None, or more than one, is no board, and
 * says why, rather than a guess at which to write.
 */
export function pickBoard(projects) {
  const boards = (projects ?? []).filter((p) => {
    const names = (p.status?.options ?? []).map((o) => o.name);
    return names.length === BOARD_COLUMNS.length && BOARD_COLUMNS.every((c) => names.includes(c));
  });
  if (boards.length === 1) return { board: boards[0], why: null };
  return { board: null, why: boards.length
    ? `${boards.length} linked projects have the plan board's columns: ${boards.map((b) => `#${b.number}`).join(", ")}`
    : `no linked project has a Status field with the columns ${BOARD_COLUMNS.join(", ")}` };
}

/**
 * Every page of a GitHub connection. `fetch(after)` returns one page as
 * `{ nodes, pageInfo }`. Stops after `limit` pages, and says whether it read
 * them all, so nothing is judged from part of a list silently.
 */
export function allNodes(fetch, limit = 50) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < limit; page++) {
    const conn = fetch(after);
    nodes.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) return { nodes, complete: true };
    after = conn.pageInfo.endCursor;
  }
  return { nodes, complete: false };
}

/**
 * Why the board must not be written from these reads, or null. A list read in
 * part moves cards the wrong way: a task whose pull request went unread would
 * leave In review.
 */
export function incompleteRead(reads) {
  const missing = Object.entries(reads).filter(([, r]) => r?.complete === false).map(([name]) => name);
  return missing.length ? `not every one of the ${missing.join(", ")} could be read, so no card was moved` : null;
}

/**
 * The cards the plan didn't visit whose issue is still open: a task left open,
 * or reopened, after its phase closed, which the plan no longer reads. Each is
 * set from its own issue, as a task of an open phase would be.
 */
export function openStrays(cards, visited) {
  return [...cards].filter(([n, c]) => !visited.has(n) && c.state === "OPEN").map(([n, c]) => ({ number: n, ...c }));
}

/**
 * The cards the plan didn't visit whose issue is closed. A closed task is Done
 * whether or not its phase is still open, and a phase closed with its last tasks
 * is no longer read at all.
 */
export function closedCards(cards, visited) {
  return [...cards].filter(([n, c]) => !visited.has(n) && c.state === "CLOSED").map(([n, c]) => ({ number: n, ...c }));
}
