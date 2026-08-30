#!/usr/bin/env node
/**
 * Ask, BEFORE merging: would this merge carry the branch tip, and is every review
 * thread settled?
 *
 *   node scripts/premerge.mjs <pr> [--repo owner/name]
 *
 * Exit 0 only for CLEAR. Anything else is non-zero, because a gate that exits 0 on
 * "I could not tell" is a gate someone wires into a script and stops reading.
 *
 * The reads live here and the JUDGEMENT lives in src/premerge.mjs, so every state
 * the gate can reach is reachable in a test without a network.
 *
 * refPath, headRepoOf and branchStateFrom are IMPORTED rather than rewritten. Each
 * carries a trap found by review: a ref name with a `#` truncates the request at the
 * fragment and answers about a prefix; a fork's head is not in origin, and falling
 * back to origin reads an unrelated branch of the same name; and `git/ref` answers
 * 404 both for an absent ref and for a repository the token cannot read, with
 * identical bodies, so the state must come from a LISTING. Reimplementing them is
 * how a fourth inventory appears that agrees only today.
 */
import { execFileSync } from "node:child_process";
import { refPath, headRepoOf, branchStateFrom } from "../src/mergecheck.mjs";
import { gate, CLEAR, REFUSE, UNREVIEWED, UNKNOWN } from "../src/premerge.mjs";

const MAXBUF = 64 << 20;
const gh = (args) => execFileSync("gh", args,
  { encoding: "utf8", maxBuffer: MAXBUF, stdio: ["ignore", "pipe", "pipe"] });
const ghJson = (args) => { try { return JSON.parse(gh(args)); } catch { return null; } };

const argv = process.argv.slice(2);
const pr = argv.find(a => /^\d+$/.test(a));
const repoAt = argv.indexOf("--repo");
const repo = repoAt >= 0 ? argv[repoAt + 1] : null;
if (!pr) {
  console.error("usage: node scripts/premerge.mjs <pr> [--repo owner/name]");
  process.exit(2);
}
const nwo = repo ?? (ghJson(["repo", "view", "--json", "nameWithOwner"])?.nameWithOwner ?? null);
if (!nwo) { console.error("premerge: cannot determine the repository"); process.exit(2); }
const [owner, name] = nwo.split("/");

// One GraphQL read for the head and the threads, so both describe the same moment.
// Two calls are two moments, and a pull request that moved between them reads as the
// gate disagreeing with itself.
const q = `query { repository(owner:"${owner}", name:"${name}") { pullRequest(number:${pr}) {
  state headRefOid headRefName isCrossRepository
  headRepositoryOwner { login } headRepository { name }
  reviewThreads(first:100) { totalCount nodes { id isResolved path
    comments(first:1) { nodes { author { login } body } } } }
  commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { nodes {
    ... on CheckRun { name conclusion status }
    ... on StatusContext { context state } } } } } } } } } }`;
const doc = ghJson(["api", "graphql", "-f", `query=${q}`]);
const meta = doc?.data?.repository?.pullRequest ?? null;
if (!meta) { console.error(`premerge: could not read ${nwo}#${pr}`); process.exit(2); }

if (meta.state !== "OPEN") {
  // Not a refusal: there is no merge to gate. Said plainly rather than as CLEAR,
  // because "already merged" is not "safe to merge".
  console.log(`premerge: ${nwo}#${pr} is ${meta.state}, so there is nothing to gate`);
  process.exit(3);
}

// The head repository, refused rather than guessed when it cannot be established.
const ids = headRepoOf(meta, nwo);
let branchNow = null, branchRead = "unreadable";
if (ids) {
  const refs = ghJson(["api", "--paginate",
    `repos/${refPath(ids.owner)}/${refPath(ids.repo)}/git/matching-refs/heads/${refPath(meta.headRefName)}`]);
  ({ branchNow, branchRead } = branchStateFrom(refs, meta.headRefName));
}

// The rollup hangs off the head COMMIT, and an absent rollup is not an empty one:
// `nodes: null` reaches checkState as unreadable rather than as "no checks", which
// are different facts and must not share an answer.
const rollup = meta.commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
const verdict = gate({
  head: { prHead: meta.headRefOid, branchNow, branchRead },
  threads: meta.reviewThreads,
  checks: { nodes: rollup ? (rollup.contexts?.nodes ?? null) : [] },
});

console.log(`${verdict.state}  ${nwo}#${pr}  head=${String(meta.headRefOid).slice(0, 7)} branch=${branchNow ? String(branchNow).slice(0, 7) : branchRead}`);
for (const line of verdict.why) console.log(`  ${line}`);
for (const t of verdict.threads.unresolved ?? []) {
  const c = t.comments?.nodes?.[0];
  console.log(`  open: ${t.path ?? "(no path)"} [${c?.author?.login ?? "?"}] ` +
              `${String(c?.body ?? "").replace(/\s+/g, " ").slice(0, 90)}`);
}
// Distinct codes, so a caller can tell WHY it is not clear without parsing text.
process.exit({ [CLEAR]: 0, [REFUSE]: 1, [UNKNOWN]: 4, [UNREVIEWED]: 5 }[verdict.state] ?? 1);
