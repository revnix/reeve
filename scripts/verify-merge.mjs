#!/usr/bin/env node
// Did a pull request's content actually reach main? The reasoning is in
// src/mergecheck.mjs, which is where it can be tested without a network; this
// is the shell that fetches the facts, exactly as capture-baseline.mjs is the
// shell over src/baseline.mjs.
//
// Usage:  node scripts/verify-merge.mjs <pr-number> [--json] [--repo owner/name]

import { execFileSync } from "node:child_process";
import { classifyFiles, verdictFor, exitFor, EXIT, VERDICT } from "../src/mergecheck.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const at = argv.indexOf("--repo");
const repo = at >= 0 ? argv[at + 1] : "revnix/reeve";
const pr = argv.find(a => /^\d+$/.test(a));

// process.exitCode, never process.exit(): exit() can truncate a pending write to
// a pipe, and a report the caller never received is worse than a slow one.
const emit = (doc, code) => {
  if (json) console.log(JSON.stringify(doc, null, 2));
  else {
    console.log(`${doc.verdict}  ${repo}#${doc.pr ?? "?"}${doc.squash ? `  squash=${doc.squash.slice(0, 7)}` : ""}`);
    for (const f of doc.files ?? []) console.log(`  ${f.state.padEnd(9)} ${f.path}`);
    if (doc.why) console.log(`\n${doc.why}`);
  }
  process.exitCode = code;
};

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

if (!pr) {
  emit({ pr: null, verdict: "USAGE", files: [],
         why: "usage: node scripts/verify-merge.mjs <pr-number> [--json] [--repo owner/name]" }, EXIT.usage);
} else {
  let meta = null;
  try {
    meta = JSON.parse(sh("gh", ["pr", "view", pr, "--repo", repo, "--json",
                                "state,mergedAt,mergeCommit,headRefOid,files"]));
  } catch (e) {
    emit({ pr, verdict: VERDICT.empty, files: [],
           why: `could not read ${repo}#${pr}: ${String(e.stderr || e.message).split("\n")[0]}` }, EXIT.unreadable);
  }

  if (meta && meta.state !== "MERGED") {
    emit({ pr, verdict: "NOT MERGED", state: meta.state, files: [],
           why: `${repo}#${pr} is ${meta.state}. There is nothing to verify yet.` }, EXIT.absent);
  } else if (meta) {
    // fetch, NEVER pull: a live guardian may be running from this checkout and
    // pull would swap code under it.
    try { execFileSync("git", ["fetch", "origin", "--quiet"], { stdio: "ignore" }); } catch {}
    const blobAt = (rev, path) => {
      try { return sh("git", ["rev-parse", `${rev}:${path}`]); } catch { return null; }
    };
    const files = classifyFiles((meta.files ?? []).map(f => f.path), {
      head: meta.headRefOid, main: "origin/main", squash: meta.mergeCommit?.oid ?? null, blobAt,
    });
    const { verdict, counts, why } = verdictFor(files);
    emit({ pr, verdict, squash: meta.mergeCommit?.oid ?? null, counts, files, why }, exitFor(verdict));
  }
}
