// plan: read where work stands from GitHub, in one place, so the snapshot and
// the board judge the same facts. It only reads. The rules applied to what it
// reads are in lib.mjs.
import { gh, completePhase } from "./lib.mjs";

/**
 * The open pull requests, and the plan: the open issues that have sub-issues
 * (phases), each with all of its tasks. `complete` is false for a list that had
 * more pages than were read, so nothing is judged from part of a list silently.
 */
export function readPlan(repo, run = gh) {
  const [owner, name] = repo.split("/");
  // Every page, not only the first.
  const allPages = (query, pick) => {
    const nodes = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
      const vars = { owner, name, ...(after ? { after } : {}) };
      const conn = pick(JSON.parse(run(["api", "graphql", "-f", `query=${query}`,
        ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`])])).data);
      nodes.push(...conn.nodes);
      if (!conn.pageInfo.hasNextPage) return { nodes, complete: true };
      after = conn.pageInfo.endCursor;
    }
    return { nodes, complete: false };
  };

  // ── pull requests, what each is waiting for, and which issues each will close
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
      id number title issueType{ name }
      subIssues(first:100){ totalCount nodes{ id number title state assignees(first:10){ nodes{ login } } } }
    } } } }`, (d) => d.repository.issues);
  // Every sub-issue of a phase, from the REST listing, in the shape the query returns.
  const readSubIssues = (n) => run(["api", "--paginate", `repos/${repo}/issues/${n}/sub_issues`, "--jq",
    ".[] | {id: .node_id, number, title, state: (.state | ascii_upcase), assignees: {nodes: [.assignees[] | {login}]}} | @json"])
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const phases = issues.nodes.filter((i) => i.subIssues.nodes.length > 0 || i.issueType?.name === "Feature")
    .map((phase) => completePhase(phase, readSubIssues));

  return { prs, issues, phases };
}

/** How many of a task's blockers are still open. */
export function openBlockers(repo, n, run = gh) {
  return Number(run(["api", `repos/${repo}/issues/${n}/dependencies/blocked_by`,
    "--jq", "[.[] | select(.state == \"open\")] | length"]).trim() || "0");
}
