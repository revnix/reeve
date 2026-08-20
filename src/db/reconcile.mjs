// Reconcilers: given an idempotency key and args, answer "did this already happen?"
// WITHOUT trusting local state. Every one is a read against the external system.
import { execFileSync } from "node:child_process";
const sh = (cmd, args, opts={}) => execFileSync(cmd, args, { encoding:"utf8", ...opts }).trim();
const ghJson = (args) => { try { return JSON.parse(sh("gh", args)); } catch (e) { return null; } };

export const MARKER = (idemKey) => `<!-- ops:${idemKey} -->`;

// 1. git push --------------------------------------------------------------
// Idempotency key: `push:<repo>:<branch>:<sha>`. The remote ref IS the receipt.
export function reconcilePush({ repo, branch, sha }) {
  const out = sh("git", ["-C", repo, "ls-remote", "origin", `refs/heads/${branch}`]);
  if (!out) return { done: false, reason: "branch absent on remote" };
  const [remoteSha, ref] = out.split("\n")[0].split(/\s+/);
  if (ref !== `refs/heads/${branch}`) return { done: false, reason: `ref mismatch ${ref}` };
  // `ls-remote origin <name>` matches a PATTERN; always compare the full ref.
  if (remoteSha === sha) return { done: true, sha: remoteSha };
  // remote moved past us? our commit is done iff it is an ancestor of the remote tip
  try { sh("git", ["-C", repo, "merge-base", "--is-ancestor", sha, remoteSha]); return { done: true, sha: remoteSha, note: "superseded by later push" }; }
  catch { return { done: false, reason: `remote at ${remoteSha.slice(0,8)}, ours ${sha.slice(0,8)} not an ancestor` }; }
}

// 2. gh pr create ----------------------------------------------------------
// Idempotency key: `pr:create:<branch>:<base>`. Two probes, in order:
//   a) head-branch lookup (cheap, exact)  b) marker-in-body search (survives branch rename)
export function reconcilePrCreate({ nwo, branch, idemKey }) {
  const byHead = ghJson(["pr","list","-R",nwo,"--head",branch,"--state","all",
                         "--json","number,url,state,headRefOid,createdAt","--limit","10"]);
  if (byHead && byHead.length === 1) return { done:true, pr: byHead[0].number, via:"head", ...byHead[0] };
  if (byHead && byHead.length > 1) {
    // branch name was reused. Disambiguate with the marker.
    const m = byHead.filter(p => (ghJson(["pr","view",String(p.number),"-R",nwo,"--json","body"])?.body||"").includes(MARKER(idemKey)));
    if (m.length === 1) return { done:true, pr:m[0].number, via:"head+marker" };
    return { done:false, ambiguous: byHead.map(p=>p.number) };
  }
  const bySearch = ghJson(["pr","list","-R",nwo,"--search",`"ops:${idemKey}" in:body`,
                           "--state","all","--json","number,url,state","--limit","5"]);
  if (bySearch && bySearch.length === 1) return { done:true, pr:bySearch[0].number, via:"marker" };
  return { done:false, reason:"no PR found by head or marker" };
}

// 3. gh pr comment ---------------------------------------------------------
// Idempotency key: `comment:<pr>:<head_sha>:<round>:<kind>`; the marker goes IN the body.
export function reconcilePrComment({ nwo, pr, idemKey }) {
  const marker = MARKER(idemKey);
  const issue = ghJson(["api",`repos/${nwo}/issues/${pr}/comments`,"--paginate",
                        "--jq",`[.[] | select(.body | contains("${marker}")) | {id, url:.html_url}]`]) || [];
  if (issue.length) return { done:true, via:"issue_comment", id: issue[0].id };
  const review = ghJson(["api",`repos/${nwo}/pulls/${pr}/comments`,"--paginate",
                         "--jq",`[.[] | select(.body | contains("${marker}")) | {id, url:.html_url}]`]) || [];
  if (review.length) return { done:true, via:"review_comment", id: review[0].id };
  return { done:false };
}

// 4. gh pr merge -----------------------------------------------------------
// Idempotency key: `merge:<pr>:<head_sha>`. Merge is a compare-and-swap:
// ALWAYS pass --match-head-commit so a merge cannot land a SHA we never gated.
export function reconcilePrMerge({ nwo, pr, headSha }) {
  const v = ghJson(["pr","view",String(pr),"-R",nwo,
                    "--json","state,mergedAt,mergeCommit,headRefOid,url"]);
  if (!v) return { done:false, reason:"pr not readable" };
  if (v.state === "MERGED") {
    // Did *our* SHA get merged, or did someone else's push land instead?
    return { done:true, mergeCommit: v.mergeCommit?.oid, mergedHead: v.headRefOid,
             ours: v.headRefOid === headSha, mergedAt: v.mergedAt };
  }
  if (v.state === "CLOSED") return { done:true, closedWithoutMerge:true };
  return { done:false, state:v.state };
}
