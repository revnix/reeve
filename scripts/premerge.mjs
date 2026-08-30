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
import { refPath, headRepoOf, branchStateFrom, safePath, EXIT } from "../src/mergecheck.mjs";
import { gate, CLEAR, REFUSE, UNREVIEWED, UNKNOWN } from "../src/premerge.mjs";

const MAXBUF = 64 << 20;
const gh = (args) => execFileSync("gh", args,
  { encoding: "utf8", maxBuffer: MAXBUF, stdio: ["ignore", "pipe", "pipe"] });
const ghJson = (args) => { try { return JSON.parse(gh(args)); } catch { return null; } };
/** Every page of a --paginate response, flattened. Null means the read failed. */
const ghPages = (args) => {
  try {
    const out = gh(args).split("\n").filter(Boolean).map(l => JSON.parse(l));
    return out.flat();
  } catch { return null; }
};

function main() {
  const argv = process.argv.slice(2);
  const pr = argv.find(a => /^\d+$/.test(a));
  const repoAt = argv.indexOf("--repo");
  // `--repo` WITH NO VALUE is a usage error, not a fallback. Taking the checkout
  // instead means an automation typo gates a different repository and returns a
  // confident verdict about the wrong pull request.
  if (repoAt >= 0 && (argv[repoAt + 1] === undefined || argv[repoAt + 1].startsWith("--"))) {
    console.error("premerge: --repo needs a value like owner/name");
    { process.exitCode = EXIT.usage; return; }
  }
  const repo = repoAt >= 0 ? argv[repoAt + 1] : null;
  if (!pr) {
    console.error("usage: node scripts/premerge.mjs <pr> [--repo owner/name]");
    { process.exitCode = EXIT.usage; return; }
  }
  // THE HOST TRAVELS WITH THE REPOSITORY. `gh repo view` resolves an Enterprise
  // remote and returns only `nameWithOwner`; a later `gh api` without --hostname then
  // defaults to github.com and can read an unrelated pull request of the same number
  // on a different host, returning a confident verdict about it.
  // READ ALWAYS, not only when the repository is being inferred. Skipping it when
  // --repo is given discarded the checkout's only source of the host, so an explicit
  // repository on an Enterprise remote fell back to github.com -- the bug this exists
  // to fix, reintroduced through the path that names the repository most precisely.
  const view = ghJson(["repo", "view", "--json", "nameWithOwner,url"]);
  const nwo = repo ?? view?.nameWithOwner ?? null;
  const host = process.env.GH_HOST
    ?? (() => { try { return view?.url ? new URL(view.url).hostname : null; } catch { return null; } })();
  const hostArgs = host && host !== "github.com" ? ["--hostname", host] : [];
  if (!nwo) { console.error("premerge: cannot determine the repository"); { process.exitCode = EXIT.usage; return; } }
  const [owner, name] = nwo.split("/");

  // One GraphQL read for the head and the threads, so both describe the same moment.
  // Two calls are two moments, and a pull request that moved between them reads as the
  // gate disagreeing with itself.
  const q = `query { repository(owner:"${owner}", name:"${name}") { pullRequest(number:${pr}) {
    state headRefOid headRefName isCrossRepository
    headRepositoryOwner { login } headRepository { name }
    reviewThreads(first:100) { totalCount nodes { id isResolved path
      comments(first:1) { nodes { author { login } body } } } }
    commits(last:1) { nodes { commit { statusCheckRollup { contexts(first:100) { totalCount nodes {
      ... on CheckRun { name conclusion status }
      ... on StatusContext { context state } } } } } } } } } }`;
  const doc = ghJson(["api", "graphql", ...hostArgs, "-f", `query=${q}`]);
  const meta = doc?.data?.repository?.pullRequest ?? null;
  if (!meta) { console.error(`premerge: could not read ${nwo}#${pr}`); { process.exitCode = 31; return; } }

  if (meta.state !== "OPEN") {
    // Not a refusal: there is no merge to gate. Said plainly rather than as CLEAR,
    // because "already merged" is not "safe to merge".
    console.log(`premerge: ${nwo}#${pr} is ${meta.state}, so there is nothing to gate`);
    { process.exitCode = EXIT.absent; return; }
  }

  // The head repository, refused rather than guessed when it cannot be established.
  const ids = headRepoOf(meta, nwo);
  let branchNow = null, branchRead = "unreadable";
  if (ids) {
    // ONE DOCUMENT PER PAGE, parsed per page. `gh api --paginate` concatenates the
    // page documents rather than merging them, so a single JSON.parse rejects a
    // multi-page answer and a perfectly readable branch reads as `unreadable` -- the
    // gate then cannot clear, ever, for a branch whose name prefixes enough others.
    // Same handling as verify-merge, rather than a second approach to one problem.
    const refs = ghPages(["api", "--paginate", ...hostArgs,
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
    checks: { nodes: rollup ? (rollup.contexts?.nodes ?? null) : [],
              totalCount: rollup ? (rollup.contexts?.totalCount ?? null) : 0 },
  });

  console.log(`${verdict.state}  ${nwo}#${pr}  head=${String(meta.headRefOid).slice(0, 7)} branch=${branchNow ? String(branchNow).slice(0, 7) : branchRead}`);
  // The FULL head, and the flag that binds a merge to it. A gate that says CLEAR and
  // leaves the caller to merge whatever is there by then has moved the race rather
  // than removed it: a push landing in between makes this verdict describe a commit
  // that is no longer the one being merged.
  if (verdict.clear)
    console.log(`  verified head: ${verdict.verifiedHead}\n` +
                `  merge bound to it with: gh pr merge ${pr} --repo ${nwo} --match-head-commit ${verdict.verifiedHead}`);
  // ESCAPED TOO. These reasons embed check names, and a check run created by a
  // contributor-controlled fork workflow names itself. Escaping the thread fields
  // below and printing these raw left the same hole one line higher up.
  for (const line of verdict.why) console.log(`  ${safePath(line)}`);
  for (const t of verdict.threads.unresolved ?? []) {
    const c = t.comments?.nodes?.[0];
    // ESCAPED, because a path and a body on an outside-contributor pull request are
    // attacker-supplied, and an ANSI or OSC sequence printed here can erase or rewrite
    // the verdict lines above it. safePath is the repository's own escaper rather than
    // a second one, and it is applied to the AUTHOR too -- a login is likelier to be
    // trusted by a reader precisely because it looks like a name.
    console.log(`  open: ${safePath(t.path ?? "(no path)")} [${safePath(c?.author?.login ?? "?")}] ` +
                `${safePath(String(c?.body ?? "").replace(/\s+/g, " ").slice(0, 90))}`);
  }
  // REEVE'S OWN 15-125 BAND, which this repository already defines and this did not
  // use. Node reserves 1 and 3-14 -- a rethrowing uncaughtException exits 7, an
  // unsettled top-level await exits 13 -- so a caller distinguishing outcomes by exit
  // status could not tell a deliberate REFUSE from an ordinary crash.
  // exitCode, NOT exit(). `process.exit` does not flush pending stdout, so a summary
  // and up to a hundred thread lines can be lost to a pipe while the status code
  // arrives intact -- automation then has a verdict with no explanation. This
  // repository already knew that and verify-merge already does it this way.
  process.exitCode = { [CLEAR]: EXIT.ok, [REFUSE]: 30, [UNKNOWN]: 31, [UNREVIEWED]: 32 }[verdict.state] ?? 30;
}

main();
