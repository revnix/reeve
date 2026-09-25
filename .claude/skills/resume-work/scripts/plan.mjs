// plan: read where work stands from GitHub, in one place, so the snapshot and
// the board judge the same facts. It only reads. The rules applied to what it
// reads are in lib.mjs.
import { gh, completePhase, completePullRequest } from "./lib.mjs";

// A pull request's own lists, as the queries below read them.
const CLOSING = "totalCount pageInfo{ hasNextPage endCursor } nodes{ number repository{ nameWithOwner } }";
const THREADS = "totalCount pageInfo{ hasNextPage endCursor } nodes{ isResolved }";
const CONTEXTS = `totalCount pageInfo{ hasNextPage endCursor } nodes{
  __typename ... on CheckRun{ name status conclusion } ... on StatusContext{ context state } }`;

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
      closingIssuesReferences(first:100){ ${CLOSING} }
      reviewThreads(first:100){ ${THREADS} }
      commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ ${CONTEXTS} } } } } }
    } } } }`, (d) => d.repository.pullRequests);
  // Each one's own lists stop at their first page there, so one that ran past it
  // is read whole, page by page.
  const nextPage = (number, field, after) => {
    const list = field === "closing" ? `closingIssuesReferences(first:100, after:$after){ ${CLOSING} }`
      : field === "threads" ? `reviewThreads(first:100, after:$after){ ${THREADS} }`
      : `commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100, after:$after){ ${CONTEXTS} } } } } }`;
    const pr = JSON.parse(run(["api", "graphql", "-f", `query=query($owner:String!,$name:String!,$n:Int!,$after:String){
      repository(owner:$owner,name:$name){ pullRequest(number:$n){ ${list} } } }`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `n=${number}`, "-f", `after=${after}`])).data.repository.pullRequest;
    return field === "closing" ? pr.closingIssuesReferences : field === "threads" ? pr.reviewThreads
      : pr.commits.nodes[0]?.commit?.statusCheckRollup?.contexts;
  };
  prs.nodes = prs.nodes.map((pr) => completePullRequest(pr, (field, after) => nextPage(pr.number, field, after)));

  // ── the plan: open issues that have sub-issues (phases), and their tasks ─────
  const issues = allPages(`query($owner:String!,$name:String!,$after:String){ repository(owner:$owner,name:$name){
    issues(states:OPEN, first:100, after:$after, orderBy:{field:CREATED_AT, direction:ASC}){
      pageInfo{ hasNextPage endCursor } nodes{
      id number title issueType{ name }
      subIssues(first:100){ totalCount nodes{ id number title state assignees(first:10){ nodes{ login } } } }
    } } } }`, (d) => d.repository.issues);
  const phases = issues.nodes.filter((i) => i.subIssues.nodes.length > 0 || i.issueType?.name === "Feature")
    .map((phase) => completePhase(phase, (n) => readSubIssues(repo, n, run)));

  return { prs, issues, phases };
}

/** Every sub-issue of an issue, from the REST listing, in the shape the plan's query returns. */
export function readSubIssues(repo, n, run = gh) {
  return run(["api", "--paginate", `repos/${repo}/issues/${n}/sub_issues`, "--jq",
    ".[] | {id: .node_id, number, title, state: (.state | ascii_upcase), assignees: {nodes: [.assignees[] | {login}]}} | @json"])
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * How many of a task's blockers are still open, from every page of them: an
 * open blocker on a later page would otherwise leave the task looking ready.
 */
export function openBlockers(repo, n, run = gh) {
  return run(["api", "--paginate", `repos/${repo}/issues/${n}/dependencies/blocked_by?per_page=100`,
    "--jq", ".[] | select(.state == \"open\") | .number"]).split("\n").filter((l) => l.trim()).length;
}
