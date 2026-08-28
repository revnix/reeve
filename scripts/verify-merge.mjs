#!/usr/bin/env node
// Did a pull request's content actually reach main? The reasoning is in
// src/mergecheck.mjs, where it is tested without a network; this is the shell
// that gathers the facts, as capture-baseline.mjs is the shell over
// src/baseline.mjs.
//
// EVERY WAY THIS CAN FAIL TO KNOW IS REPORTED AS UNREADABLE, never as a verdict.
// A verifier that answers from a stale ref, a truncated file list, or a revision
// it could not fetch is worse than no verifier: it is the false reassurance the
// tool exists to remove, wearing the tool's authority.
//
// Usage:  node scripts/verify-merge.mjs <pr-number> [--json] [--repo owner/name]

import { execFileSync } from "node:child_process";
import { classifyFiles, verdictFor, pathsOf, exitFor, EXIT, VERDICT, ABSENT, UNREAD }
  from "../src/mergecheck.mjs";

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
    for (const f of doc.files ?? []) console.log(`  ${f.state.padEnd(9)} ${f.path}`);
    if (doc.why) console.log(`\n${doc.why}`);
  }
  process.exitCode = code;
};

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const first = (e) => String(e?.stderr || e?.message || e).split("\n")[0];

const run = () => {
  if (!pr) return emit({ verdict: "USAGE", files: [],
    why: "usage: node scripts/verify-merge.mjs <pr-number> [--json] [--repo owner/name]" }, EXIT.usage);

  // THE CHECKOUT MUST BE THE REPOSITORY BEING ASKED ABOUT. Otherwise GitHub's
  // metadata comes from one repository and every tree comparison from another,
  // and the result is a confident verdict about two different things.
  let originNwo = null;
  try {
    const url = sh("git", ["remote", "get-url", "origin"]);
    const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
    originNwo = m ? m[1] : null;
  } catch (e) {
    return emit({ verdict: VERDICT.unreadable, files: [], why: `no usable origin remote: ${first(e)}` }, EXIT.unreadable);
  }
  const repo = repoArg ?? originNwo;
  if (!originNwo) return emit({ repo, pr, verdict: VERDICT.unreadable, files: [],
    why: "could not parse owner/name out of origin's URL, so the tree side cannot be bound to the repository being asked about." }, EXIT.unreadable);
  if (repo !== originNwo) return emit({ repo, pr, verdict: VERDICT.unreadable, files: [],
    why: `--repo names ${repo} but this checkout's origin is ${originNwo}.\n` +
         `Metadata would come from one repository and every tree comparison from the other. Run this from a checkout of ${repo}.` }, EXIT.unreadable);

  let meta;
  try {
    meta = JSON.parse(sh("gh", ["pr", "view", pr, "--repo", repo, "--json",
                                "state,mergedAt,mergeCommit,headRefOid,changedFiles"]));
  } catch (e) {
    return emit({ repo, pr, verdict: VERDICT.unreadable, files: [], why: `could not read ${repo}#${pr}: ${first(e)}` }, EXIT.unreadable);
  }
  if (meta.state !== "MERGED") {
    return emit({ repo, pr, verdict: "NOT MERGED", state: meta.state, files: [],
      why: `${repo}#${pr} is ${meta.state}. There is nothing to verify yet.` }, EXIT.absent);
  }

  // THE FILE LIST, PAGINATED, and checked against the count GitHub reports.
  // `gh pr view --json files` asks for `files(first: 100)`, so a larger pull
  // request is silently truncated and a verdict over the prefix could exit 0
  // while an omitted path is absent from main.
  let files;
  try {
    files = JSON.parse(sh("gh", ["api", "--paginate", `repos/${repo}/pulls/${pr}/files`, "--slurp"])).flat();
  } catch (e) {
    return emit({ repo, pr, verdict: VERDICT.unreadable, files: [], why: `could not list the files of ${repo}#${pr}: ${first(e)}` }, EXIT.unreadable);
  }
  if (typeof meta.changedFiles === "number" && files.length !== meta.changedFiles) {
    return emit({ repo, pr, verdict: VERDICT.unreadable, files: [],
      why: `the file list is short: GitHub reports ${meta.changedFiles} changed files and pagination returned ${files.length}.\n` +
           `Refusing rather than verifying a prefix -- an omitted path is exactly what this would fail to notice.` }, EXIT.unreadable);
  }

  // A FETCH THAT FAILED MUST NOT BECOME A VERDICT. Comparing against a stale
  // origin/main can match a current head and exit 0 while the real remote tree
  // differs. `fetch`, never `pull`: a live guardian may run from this checkout.
  try {
    execFileSync("git", ["fetch", "origin", "--quiet"], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    return emit({ repo, pr, verdict: VERDICT.unreadable, files: [],
      why: `could not refresh origin: ${first(e)}\nRefusing to classify against refs that may be stale.` }, EXIT.unreadable);
  }

  // THE PULL REQUEST HEAD IS NOT NECESSARILY LOCAL. A squash commit does not
  // retain the branch head as a parent, and origin's refspec is
  // +refs/heads/*:refs/remotes/origin/* -- no refs/pull/*. So from a fresh clone
  // of a repository whose merged branch was deleted, every path reads absent at
  // head and the tool reports a correctly-merged pull request as MISSING.
  const head = meta.headRefOid;
  const have = (rev) => { try { sh("git", ["cat-file", "-e", `${rev}^{commit}`]); return true; } catch { return false; } };
  if (!have(head)) {
    try { execFileSync("git", ["fetch", "origin", `pull/${pr}/head`, "--quiet"], { stdio: ["ignore", "ignore", "pipe"] }); }
    catch { /* fall through to the check below, which reports it properly */ }
  }
  if (!have(head)) {
    return emit({ repo, pr, verdict: VERDICT.unreadable, files: [],
      why: `the pull request head ${head.slice(0, 7)} is not in this checkout and could not be fetched from refs/pull/${pr}/head.\n` +
           `Without it every path would read as absent at head, and a merged pull request would be reported as MISSING.` }, EXIT.unreadable);
  }

  const squash = meta.mergeCommit?.oid ?? null;
  if (squash && !have(squash)) {
    return emit({ repo, pr, verdict: VERDICT.unreadable, files: [],
      why: `the squash commit ${squash.slice(0, 7)} is not readable in this checkout, so arrival cannot be told from drift.` }, EXIT.unreadable);
  }

  // TREE ENTRY, not blob: mode lives in the tree, so an executable bit or a
  // symlink flag that never arrived shares its blob id with one that did.
  // ABSENT only ever means "this revision was read and holds no such path" --
  // every revision here has been proven readable above.
  const entryAt = (rev, path) => {
    let out;
    try { out = sh("git", ["ls-tree", "--full-tree", rev, "--", path]); }
    catch (e) { throw new Error(`git ls-tree failed for ${rev}:${path}: ${first(e)}`); }
    if (!out) return ABSENT;
    const [meta_, rest] = [out.slice(0, out.indexOf("\t")), out.slice(out.indexOf("\t") + 1)];
    const [mode, , id] = meta_.split(/\s+/);
    void rest;
    return { mode, id };
  };

  let classified;
  try {
    classified = classifyFiles(pathsOf(files), { head, main: "origin/main", squash: squash ?? UNREAD, entryAt });
  } catch (e) {
    return emit({ repo, pr, verdict: VERDICT.unreadable, files: [], why: first(e) }, EXIT.unreadable);
  }
  const { verdict, counts, why } = verdictFor(classified);
  emit({ repo, pr, verdict, squash, counts, files: classified, why }, exitFor(verdict));
};

run();
