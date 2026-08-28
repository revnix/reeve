#!/usr/bin/env node
// Is a merged pull request's content still on main? The reasoning is in
// src/mergecheck.mjs, where it is tested without a network; this is the shell
// that gathers the facts, as capture-baseline.mjs is the shell over
// src/baseline.mjs.
//
// EVERY WAY THIS CAN FAIL TO KNOW IS REPORTED AS UNREADABLE, never as a verdict.
// A verifier that answers from a stale ref, a truncated file list, a revision it
// could not fetch, or a merge into a branch it was not asked about is worse than
// no verifier: it is the false reassurance the tool exists to remove, wearing
// the tool's authority.
//
// Usage:  node scripts/verify-merge.mjs <pr-number> [--json] [--repo owner/name]

import { execFileSync } from "node:child_process";
import { classifyFiles, verdictFor, pathsOf, branchOnlyPaths, gitFacts, safePath, exitFor, EXIT, VERDICT }
  from "../src/mergecheck.mjs";

// execFileSync defaults to a 1 MiB stdout buffer and THROWS ENOBUFS past it.
// The pull-request files endpoint carries a URL trio and often patch text per
// entry, so a pull request far below GitHub's 3,000-file ceiling can exceed it
// -- turning the pagination that exists to handle large lists into the thing
// that fails on them. Projected with --jq to two fields as well, so the patch
// bodies never enter this buffer at all.
const MAXBUF = 256 * 1024 * 1024;

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const at = argv.indexOf("--repo");
const repoArg = at >= 0 ? argv[at + 1] : null;
const pr = argv.find(a => /^\d+$/.test(a));

const emit = (doc, code) => {
  // process.exitCode, never process.exit(): exit() can truncate a pending write
  // to a pipe, and a report the caller never received is worse than a slow one.
  if (json) console.log(JSON.stringify(doc, null, 2));
  else {
    console.log(`${doc.verdict}  ${doc.repo ?? "?"}#${doc.pr ?? "?"}${doc.squash ? `  squash=${doc.squash.slice(0, 7)}` : ""}`);
    // safePath, not the raw name: a filename is attacker-supplied on any
    // repository taking outside contributions, and a carriage return or an ANSI
    // escape in one can overwrite the verdict line above or forge a new one.
    for (const f of doc.files ?? []) console.log(`  ${f.state.padEnd(8)} ${safePath(f.path)}`);
    if (doc.why) console.log(`\n${doc.why}`);
  }
  process.exitCode = code;
};

// RAW, not trimmed. `git diff-tree -z` output is NUL-delimited and a filename
// may BEGIN with a space or a tab: a global trim strips that byte off the first
// path. Scalar results are trimmed at their own call sites instead.
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: MAXBUF, stdio: ["ignore", "pipe", "pipe"] });
// One runner, injected into the seam, so the argument lists this builds are the
// same ones the tests drive. See src/mergecheck.mjs for what each read asserts.
const G = gitFacts((args) => sh("git", args));
const first = (e) => String(e?.stderr || e?.message || e).split("\n")[0];

const run = () => {
  if (!pr) return emit({ verdict: "USAGE", files: [],
    why: "usage: node scripts/verify-merge.mjs <pr-number> [--json] [--repo owner/name]" }, EXIT.usage);

  // THE HOST IS PART OF THE IDENTITY. An origin on GitHub Enterprise, or a local
  // mirror, can carry the same owner/name as a repository on github.com -- and
  // `gh` defaults to github.com. Keeping only owner/name lets metadata come from
  // one host while every tree comparison reads the other.
  let originHost = null, originNwo = null;
  try {
    const url = sh("git", ["remote", "get-url", "origin"]).trim();
    const m = url.match(/^(?:git@([^:]+):|(?:ssh:\/\/)?git@([^/:]+)(?::\d+)?\/|https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/)(.+?)(?:\.git)?\/?$/);
    if (m) { originHost = m[1] || m[2] || m[3] || null; originNwo = m[4] || null; }
  } catch (e) {
    return emit({ verdict: VERDICT.unreadable, files: [], why: `no usable origin remote: ${first(e)}` }, EXIT.unreadable);
  }
  if (!originNwo || !originHost) return emit({ repo: repoArg, pr, verdict: VERDICT.unreadable, files: [],
    why: "could not parse a host and owner/name out of origin's URL, so the tree side cannot be bound to the repository being asked about." }, EXIT.unreadable);

  const repo = repoArg ?? originNwo;
  const ghRepo = `${originHost}/${originNwo}`;
  const wantHost = repo.split("/").length === 3 ? repo.split("/")[0] : originHost;
  const wantNwo = repo.split("/").slice(-2).join("/");
  if (wantNwo !== originNwo || wantHost !== originHost) {
    return emit({ repo: `${wantHost}/${wantNwo}`, pr, verdict: VERDICT.unreadable, files: [],
      why: `--repo names ${wantHost}/${wantNwo} but this checkout's origin is ${ghRepo}.\n` +
           `Metadata would come from one repository and every tree comparison from the other. Run this from a checkout of it.` }, EXIT.unreadable);
  }

  let meta;
  try {
    meta = JSON.parse(sh("gh", ["pr", "view", pr, "--repo", ghRepo, "--json",
                                "state,mergedAt,mergeCommit,headRefOid,baseRefName,changedFiles"]));
  } catch (e) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, files: [], why: `could not read ${ghRepo}#${pr}: ${first(e)}` }, EXIT.unreadable);
  }
  if (meta.state !== "MERGED") {
    return emit({ repo: ghRepo, pr, verdict: "NOT MERGED", state: meta.state, files: [],
      why: `${ghRepo}#${pr} is ${meta.state}. There is nothing to verify yet.` }, EXIT.absent);
  }

  // WHICH BRANCH DID IT MERGE INTO? Everything below compares against
  // origin/main. A pull request merged into `release` produced a squash commit
  // on THAT branch, and using it as evidence about main would report arrival
  // somewhere else as arrival here.
  if (meta.baseRefName && meta.baseRefName !== "main") {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, base: meta.baseRefName, files: [],
      why: `${ghRepo}#${pr} merged into '${meta.baseRefName}', not 'main'.\n` +
           `Its squash commit is evidence about '${meta.baseRefName}' and says nothing about main. This only answers for main.` }, EXIT.unreadable);
  }

  const squash = meta.mergeCommit?.oid ?? null;
  if (!squash) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, files: [],
      why: `${ghRepo}#${pr} is merged but reports no merge commit, so there is nothing authoritative to compare main against.` }, EXIT.unreadable);
  }

  // A FETCH THAT FAILED MUST NOT BECOME A VERDICT, and the refspec is explicit:
  // a bare `git fetch origin` follows whatever remote.origin.fetch maps, and a
  // narrow clone may not map refs/heads/main at all -- the fetch then SUCCEEDS
  // while origin/main stays stale. `fetch`, never `pull`: a live guardian may be
  // running from this checkout.
  try {
    execFileSync("git", ["fetch", "origin", "refs/heads/main:refs/remotes/origin/main", "--quiet"],
                 { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, files: [],
      why: `could not refresh origin: ${first(e)}\nRefusing to classify against refs that may be stale.` }, EXIT.unreadable);
  }

  const have = (rev) => { try { sh("git", ["cat-file", "-e", `${rev}^{commit}`]); return true; } catch { return false; } };
  if (!have(squash)) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, squash, files: [],
      why: `the squash commit ${squash.slice(0, 7)} is not readable in this checkout, so there is nothing authoritative to compare main against.` }, EXIT.unreadable);
  }

  // PIN origin/main TO AN OBJECT ID, immediately after the fetch. It is a
  // MUTABLE ref: left as the name, every ls-tree below re-resolves it, and
  // another process fetching mid-run (the live guardian's checkout does exactly
  // this) would have some paths compared against the old main and some against
  // the new. Neither snapshot need have contained the whole merged tree, and the
  // mixture can read all-INTACT. One ref read, one snapshot, one answer.
  let mainOid;
  try { mainOid = G.pinMain(); }
  catch (e) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, squash, files: [],
      why: `could not resolve origin/main to a commit: ${first(e)}` }, EXIT.unreadable);
  }

  // THE PATHS COME FROM THE MERGE, NOT FROM THE API. `pulls/<n>/files` describes
  // the branch HEAD, which a push after the merge moves -- and such a push can
  // change WHICH paths are listed without changing HOW MANY, so a count check
  // cannot catch it and the omitted path is never compared. The merge commit's
  // own diff is the exact set the merge produced.
  //
  // `--no-renames` because rename detection would collapse a rename to its
  // destination and drop the source side, and `diff.renames` is a repository
  // setting this must not be at the mercy of. `-z` because a filename may
  // contain a newline, and git would otherwise quote it into a different string.
  const parents = G.parentsOf(squash);
  if (parents.length !== 1) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, squash, files: [],
      why: `the merge commit ${squash.slice(0, 7)} has ${parents.length} parents, so it is not a squash.\n` +
           `This compares main against a single-parent squash and cannot enumerate the paths of a ${parents.length}-parent merge correctly. Refusing rather than verifying a subset.` }, EXIT.unreadable);
  }
  let mergePaths;
  try {
    mergePaths = G.mergePaths(squash);
  } catch (e) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, squash, files: [],
      why: `could not read the merge commit's diff: ${first(e)}` }, EXIT.unreadable);
  }

  // CAN A REBASE MERGE BE RULED OUT? `mergeCommit.oid` for a rebase merge is the
  // LAST rebased commit -- one parent, like a squash, but its diff covers only
  // that commit. The two are indistinguishable from the commit alone. They are
  // distinguishable from the REPOSITORY: if rebase merges are disabled, a
  // one-parent merge commit is a squash and carries the whole branch. Unproven
  // is the safe default, and it makes uncovered paths refuse rather than pass.
  let squashProven = false;
  try {
    const repoCfg = JSON.parse(sh("gh", ["api", "--hostname", originHost, `repos/${originNwo}`]));
    squashProven = repoCfg.allow_rebase_merge === false;
  } catch { /* unproven, which is the safe direction */ }

  // THE API LIST IS NOW ONLY A CROSS-CHECK, and its failure is not the verdict's
  // failure: the verdict comes from the merge's own diff, read locally. Projected
  // to two fields so the patch bodies never reach this process.
  let apiPaths = [], crossCheck = "complete";
  try {
    const raw = sh("gh", ["api", "--hostname", originHost, "--paginate",
                          `repos/${originNwo}/pulls/${pr}/files`,
                          "--jq", ".[]|{filename,previous_filename}"]);
    apiPaths = pathsOf(raw.split("\n").filter(Boolean).map(l => JSON.parse(l)));
    if (typeof meta.changedFiles === "number" && apiPaths.length < meta.changedFiles) {
      crossCheck = `GitHub reports ${meta.changedFiles} changed files and pagination returned ${apiPaths.length}`;
    }
  } catch (e) {
    crossCheck = `could not list the files of ${ghRepo}#${pr}: ${first(e)}`;
  }

  // The head is OPTIONAL and never decides the verdict -- it only reports
  // divergence. A squash keeps no parent link to the branch and origin's refspec
  // carries no refs/pull/*, so it may simply not be present, and that is fine.
  let headRev = null;
  if (meta.headRefOid) {
    if (!have(meta.headRefOid)) {
      try { execFileSync("git", ["fetch", "origin", `pull/${pr}/head`, "--quiet"], { stdio: ["ignore", "ignore", "pipe"] }); } catch { /* optional */ }
    }
    if (have(meta.headRefOid)) headRev = meta.headRefOid;
  }

  // TREE ENTRY, not blob: mode lives in the tree, so an executable bit or a
  // symlink flag that never arrived shares its blob id with one that did.
  const entryAt = (rev, path) => {
    try { return G.entryAt(rev, path); }
    catch (e) { throw new Error(`git ls-tree failed for ${rev}: ${first(e)}`); }
  };

  let classified;
  try {
    const opts = { squash, main: mainOid, entryAt };
    if (headRev) opts.head = headRev;
    classified = classifyFiles(mergePaths, opts);
  } catch (e) {
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, squash, files: [], why: first(e) }, EXIT.unreadable);
  }
  const branchOnly = branchOnlyPaths(apiPaths, mergePaths);
  const { verdict, counts, why } = verdictFor(classified, { branchOnly, crossCheck, squashProven });
  emit({ repo: ghRepo, pr, verdict, squash, main: mainOid, base: meta.baseRefName ?? null,
         headRead: headRev !== null, crossCheck, branchOnly, squashProven, counts, files: classified, why },
       exitFor(verdict));
};

run();
