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
import { classifyFiles, verdictFor, pathsOf, branchOnlyPaths, gitFacts, displayPath, toByteString,
         crossCheckState, parseArgs, summaryLine, exitFor, EXIT, VERDICT, ABSENT } from "../src/mergecheck.mjs";

// execFileSync defaults to a 1 MiB stdout buffer and THROWS ENOBUFS past it.
// The pull-request files endpoint carries a URL trio and often patch text per
// entry, so a pull request far below GitHub's 3,000-file ceiling can exceed it
// -- turning the pagination that exists to handle large lists into the thing
// that fails on them. Projected with --jq to two fields as well, so the patch
// bodies never enter this buffer at all.
const MAXBUF = 256 * 1024 * 1024;

const { json, repoArg, repoMissingValue, pr } = parseArgs(process.argv.slice(2));

const emit = (doc, code) => {
  // process.exitCode, never process.exit(): exit() can truncate a pending write
  // to a pipe, and a report the caller never received is worse than a slow one.
  // DECODE EXACTLY ONCE, HERE, for whichever output is asked for. `doc` carries
  // raw latin1 byte-strings throughout; decoding them earlier AND here would run
  // displayPath over its own output, re-reading finished Unicode text as latin1
  // bytes -- `café.txt` became `caf\xe9.txt`, and anything above U+00FF loses
  // its high bits entirely, so the report names a different file.
  const shown = (doc.files ?? []).map(f => ({ ...f, path: displayPath(f.path) }));
  if (json) console.log(JSON.stringify({ ...doc, files: shown }, null, 2));
  else {
    console.log(summaryLine(doc));
    // displayPath, not the raw name: a filename is attacker-supplied on any
    // repository taking outside contributions, and a carriage return or an ANSI
    // escape in one can overwrite the verdict line above or forge a new one.
    for (const f of shown) console.log(`  ${f.state.padEnd(8)} ${f.path}`);
    if (doc.why) console.log(`\n${doc.why}`);
  }
  process.exitCode = code;
};

// RAW, not trimmed. `git diff-tree -z` output is NUL-delimited and a filename
// may BEGIN with a space or a tab: a global trim strips that byte off the first
// path. Scalar results are trimmed at their own call sites instead.
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: MAXBUF, stdio: ["ignore", "pipe", "pipe"] });
// GIT output is read as `latin1`, which maps every byte to one code point, so a
// filename containing invalid UTF-8 survives intact. Decoding it as UTF-8 would
// replace those bytes with U+FFFD -- a DIFFERENT name, absent from both
// revisions, classified REMOVED, which is a passing state. `gh` stays UTF-8
// because its output is JSON.
const shGit = (args) => execFileSync("git", args, { encoding: "latin1", maxBuffer: MAXBUF, stdio: ["ignore", "pipe", "pipe"] });
// One runner, injected into the seam, so the argument lists this builds are the
// same ones the tests drive. See src/mergecheck.mjs for what each read asserts.
const G = gitFacts(shGit);
const first = (e) => String(e?.stderr || e?.message || e).split("\n")[0];

const run = () => {
  if (repoMissingValue) return emit({ verdict: "USAGE", files: [],
    why: "--repo was given with no value. Refusing rather than falling back to this checkout's origin, which would answer about a repository you did not name.\n" +
         "usage: node scripts/verify-merge.mjs <pr-number> [--json] [--repo owner/name]" }, EXIT.usage);
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
                                "state,mergedAt,mergeCommit,headRefOid,headRefName,baseRefName,changedFiles"]));
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
    G.fetchMain();
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
  let parents;
  try { parents = G.parentsOf(squash); }
  catch (e) {
    // Throwing here would exit with Node's generic code and a stack trace,
    // breaking the exit-code contract every caller reads.
    return emit({ repo: ghRepo, pr, verdict: VERDICT.unreadable, squash, files: [],
      why: `could not read the merge commit's parents: ${first(e)}` }, EXIT.unreadable);
  }
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
  // LAST rebased commit -- one parent, like a squash, but covering only that
  // commit, so earlier commits' paths would go unchecked.
  //
  // NOT from the repository's current settings. `allow_rebase_merge` is present
  // state and says nothing about how an EXISTING merge was performed: a pull
  // request rebase-merged while it was enabled would be marked proven the moment
  // an administrator turns it off, which is the exact false pass this guards.
  //
  // The sound test is per pull request: with ONE commit, a rebase merge and a
  // squash produce the same coverage, so the merge commit carries the whole
  // branch whichever was used. More than one commit and this cannot tell, so it
  // refuses -- unproven is the safe default.

  // THE API LIST IS NOW ONLY A CROSS-CHECK, and its failure is not the verdict's
  // failure: the verdict comes from the merge's own diff, read locally. Projected
  // to two fields so the patch bodies never reach this process.
  let apiPaths = [], crossCheck = "complete";
  try {
    const raw = sh("gh", ["api", "--hostname", originHost, "--paginate",
                          `repos/${originNwo}/pulls/${pr}/files`,
                          "--jq", ".[]|{filename,previous_filename}"]);
    const records = raw.split("\n").filter(Boolean).map(l => JSON.parse(l));
    // COUNT THE RECORDS, NOT THE EXPANDED PATHS. `pathsOf` adds a rename's
    // source as well as its destination, so one rename hides one missing
    // record -- reachable at the endpoint's documented 3,000-file limit, where
    // the short list would then read as complete.
    crossCheck = crossCheckState(records.length, meta.changedFiles);
    // Normalised to the same byte-string form the git reads use, or a non-ASCII
    // path would differ from its own git-side spelling and read as uncovered.
    apiPaths = pathsOf(records).map(toByteString);
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
    // `have` proves the COMMIT is present; in a partial clone its tree may still
    // be unfetchable. The head never decides the verdict, so a tree that cannot
    // be read drops the divergence OBSERVATION rather than suppressing an
    // authoritative answer the squash and main trees can still give.
    if (have(meta.headRefOid)) {
      try { G.treeEntries(meta.headRefOid); headRev = meta.headRefOid; }
      catch { headRev = null; }
    }
  }

  // TREE ENTRY, not blob: mode lives in the tree, so an executable bit or a
  // symlink flag that never arrived shares its blob id with one that did.
  // One listing per revision, then Map lookups. A path read out of git is never
  // handed back to git as an argument, so no filename has to survive a round
  // trip through argv's UTF-8 encoding.
  const trees = new Map();
  const treeOf = (rev) => {
    if (!trees.has(rev)) trees.set(rev, G.treeEntries(rev));
    return trees.get(rev);
  };
  const entryAt = (rev, path) => {
    let t;
    try { t = treeOf(rev); }
    catch (e) { throw new Error(`git ls-tree failed for ${rev}: ${first(e)}`); }
    return t.get(path) ?? ABSENT;
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
  const { verdict, counts, why } = verdictFor(classified, { branchOnly, crossCheck });
  // DECODE AT THE OUTPUT BOUNDARY. Paths are carried internally as latin1
  // byte-strings so no byte is lost in comparison, but that is a transport, not
  // a name: serialised straight to JSON, `café.txt` reads as `cafÃ©.txt` and the
  // structured report names a file that does not exist.
  // WHERE IS THE BRANCH NOW? `headRefOid` is FROZEN at the moment of merge, so
  // it cannot reveal a commit pushed afterwards -- and that is exactly the case
  // this reports on. MEASURED on reeve#63: GitHub reported headRefOid 9232d4a
  // while `refs/heads/feat/stub-sweep` stood at 4e5df36, six commits later, none
  // of them on main. The frozen value looks current and is not, which makes
  // printing it alone worse than printing nothing.
  //
  // Three answers, not two: read, deleted, or unreadable. A deleted branch
  // cannot have moved; an unreadable one is UNKNOWN and says so.
  let branchNow = null, branchRead = "unreadable";
  if (!meta.headRefName) branchRead = "unreadable";
  else {
    try {
      const out = sh("git", ["ls-remote", "origin", `refs/heads/${meta.headRefName}`]).trim();
      if (out === "") { branchRead = "gone"; }
      else { branchNow = out.split(/\s+/)[0]; branchRead = "read"; }
    } catch { branchRead = "unreadable"; }
  }

  emit({ repo: ghRepo, pr, verdict, squash, main: mainOid, base: meta.baseRefName ?? null,
         mergedHead: meta.headRefOid ?? null, branchNow, branchRead,
         head: headRev, headRead: headRev !== null,
         crossCheck, branchOnly: branchOnly.map(displayPath),
         counts, files: classified, why },
       exitFor(verdict));
};

run();
