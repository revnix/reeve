#!/usr/bin/env node
// What is true right now -- as a SCRIPT, in the repository, rather than as a
// fenced block inside a handoff document.
//
// WHY THIS MOVED. The block it replaces lived in markdown, was re-derived by
// hand each session, and was the first thing a resumed session ran. Nothing
// tested it, nothing linted it, and the stub sweep could not see it. It shipped
// two defects that a resumed session would have read as bad news about a healthy
// repository, and the resume instructions say to STOP when it fails:
//
//   1. `git show <ref>:<path> | grep -m1 PATTERN || note_refusal`
//      grep exits at the first match, `git show` takes SIGPIPE, and under
//      `set -o pipefail` the pipeline reports 141. So the handler fired on a
//      SUCCESSFUL read: the correct schema version was printed one line above a
//      refusal saying it could not be read. Measured 2026-09-02, bash rc=141 --
//      and zsh rc=0, so testing it interactively would have "proved" it fine.
//
//   2. The isolated sweep worktree was created with `git worktree add` and never
//      had dependencies installed, so `test/lint-no-url-pathname.test.mjs`, which
//      does `import { RuleTester } from "eslint"`, could not run at all. The
//      sweep correctly reported UNRUNNABLE, the block correctly reported the
//      sweep had failed, and the conclusion -- that something was wrong with
//      main -- was false. Main's CI was green on that same commit.
//
// Both are the same shape: a guard that alarms on success. Neither is possible
// here, because nothing below builds a shell pipeline: every command runs through
// `execFileSync` with an argument vector, and its exit status is the only status
// there is.
//
// `tools/watch-prs.sh` carries this lesson in its own header, having been moved
// into the repository for the same reason. This is that, for state.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run a command with an argument vector. No shell, so no pipeline to hide a status. */
export function runner(cwd = process.cwd()) {
  return (cmd, args, { timeout = 120_000 } = {}) => {
    try {
      return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", timeout,
        stdio: ["ignore", "pipe", "pipe"] }).trim() };
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? "").trim(),
               err: (String(e.stderr || e.message).split("\n").filter(Boolean).pop() ?? "failed").slice(0, 200) };
    }
  };
}

/**
 * The commit a RUNNING daemon loaded, from its log.
 *
 * Returns null when the log says nothing, and null is a REFUSAL to the caller
 * rather than a value. The shell version piped through `tail`, which exits 0 on
 * empty input -- so a missing log, an unreadable one, and one with no such record
 * all printed a blank line that read as a measurement.
 */
export function runningCommitFrom(logText) {
  const hits = [...String(logText ?? "").matchAll(/running commit ([0-9a-f]{7,40})/g)];
  return hits.length ? hits[hits.length - 1][1] : null;
}

/**
 * The schema version a source file declares, or null.
 *
 * Takes TEXT, not a command. The defect this replaces was entirely in how the
 * text was fetched, so the fetch is the caller's problem and this cannot repeat
 * it.
 */
export function schemaVersionFrom(sourceText) {
  const m = /HUB_SCHEMA_VERSION\s*=\s*(\d+)/.exec(String(sourceText ?? ""));
  return m ? Number(m[1]) : null;
}

/** Branches carrying commits that main does not have, and that no pull request claims. */
export function unopenedBranches(branches, prHeadRefs) {
  const claimed = new Set(prHeadRefs ?? []);
  return (branches ?? []).filter(b => !claimed.has(b));
}

/**
 * What a sweep run MEANS, which is not what its exit code says.
 *
 * A sweep exits non-zero both when an assertion cannot fail -- the finding it
 * exists to produce -- and when a test could not be executed at all. The second
 * is a fact about the machine the sweep ran on, and reporting it as the first is
 * exactly the false alarm this script was written after.
 */
export function sweepVerdict({ ok, out }) {
  if (ok) return { level: "ok", lines: [(out ?? "").split("\n").filter(Boolean).slice(-2).join(" | ")] };
  const text = String(out ?? "");
  const unrunnable = [...text.matchAll(/^\s*·\s*(\S+): (UNRUNNABLE|CRASHED|TIMED_OUT)$/gm)].map(m => `${m[1]} ${m[2]}`);
  const uncaught = [...text.matchAll(/^\s*·\s*(\S+): (NOT_CAUGHT|WRONG_RED)$/gm)].map(m => `${m[1]} ${m[2]}`);
  if (uncaught.length) return { level: "refusal",
    lines: [`${uncaught.length} assertion(s) cannot fail for the reason they name:`, ...uncaught] };
  if (unrunnable.length) return { level: "environment",
    lines: [`the sweep could not RUN ${unrunnable.length} entr(ies) here:`, ...unrunnable,
            "this is a fact about this machine rather than about the code -- check dependencies are installed in the sweep tree"] };
  return { level: "refusal", lines: ["the sweep failed and named no verdict", text.split("\n").slice(-3).join(" | ")] };
}

// ── the report ────────────────────────────────────────────────────────────────

const REPO = process.env.REEVE_REPO_ROOT ?? join(import.meta.dirname, "..");

function main(argv) {
  const run = runner(REPO);
  const out = [];
  let refusals = 0;
  const say = (...l) => out.push(...l);
  const refuse = (why) => { refusals++; say(`REFUSES: ${why}`); };

  // A FAILED FETCH IS SILENT, and every read below would then answer from the
  // cached remote-tracking ref -- reporting stale state at the moment this exists
  // to re-measure it. So this one aborts rather than accumulating.
  const fetched = run("git", ["fetch", "origin", "--quiet"]);
  if (!fetched.ok) { console.error(`REFUSES: could not fetch origin: ${fetched.err}`); return 1; }

  const mainTip = run("git", ["log", "--oneline", "-1", "origin/main"]);
  mainTip.ok ? say(`main            ${mainTip.out}`) : refuse(`could not read origin/main: ${mainTip.err}`);

  // WHAT THE DAEMON WOULD RUN, and what it IS running, are different facts: a
  // running process holds the modules it loaded at startup, so moving the
  // checkout moves the tree and not the process.
  const head = run("git", ["rev-parse", "--short", "HEAD"]);
  const behind = run("git", ["rev-list", "--count", "HEAD..origin/main"]);
  if (head.ok && behind.ok) say(`this checkout   ${head.out}, ${behind.out} behind origin/main`);
  else refuse(`could not compare this checkout to origin/main: ${head.err ?? behind.err}`);

  let log = null;
  try { log = readFileSync(join(process.env.REEVE_HOME ?? join(process.env.HOME ?? "", ".reeve"), "reeve.log"), "utf8"); }
  catch { log = null; }
  const running = runningCommitFrom(log);
  if (log === null) refuse("no daemon log could be read, so what the running process loaded is unknown");
  else if (running === null) refuse("the daemon log records no `running commit`, so what it loaded is unknown");
  else say(`daemon running  ${running}`);

  const src = run("git", ["show", "origin/main:src/build/hubdb.mjs"]);
  if (!src.ok) refuse(`could not read hubdb.mjs from origin/main: ${src.err}`);
  else {
    const v = schemaVersionFrom(src.out);
    v === null ? refuse("origin/main declares no HUB_SCHEMA_VERSION") : say(`hub schema      ${v} (next migration ${v + 1})`);
  }

  const prs = run("gh", ["pr", "list", "--repo", "revnix/reeve", "--state", "open",
                         "--json", "number,headRefName", "--jq", ".[]|\"\\(.number) \\(.headRefName)\""]);
  if (!prs.ok) refuse(`could not list open pull requests: ${prs.err}`);
  else {
    const lines = prs.out.split("\n").filter(Boolean);
    say("", `open pull requests (${lines.length})`, ...lines.map(l => `  #${l}`));
    // ANY pull request, in any state -- not just the open ones. main is
    // squash-merged, so a merged branch's commits are literally absent from
    // main's history and `rev-list origin/main..origin/<b>` counts them as
    // unopened work. Filtering on OPEN pull requests alone reported 136
    // branches, of which about a dozen were real; a list that long is one
    // nobody reads, which is the same failure as not reporting at all.
    const everPr = run("gh", ["pr", "list", "--repo", "revnix/reeve", "--state", "all",
                              "--limit", "500", "--json", "headRefName",
                              "--jq", ".[].headRefName"]);
    if (!everPr.ok) refuse(`could not list pull requests to tell unopened work from merged: ${everPr.err}`);
    const heads = everPr.ok ? everPr.out.split("\n").filter(Boolean) : lines.map(l => l.split(" ").slice(1).join(" "));
    const branches = run("git", ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"]);
    if (!branches.ok) refuse(`could not list remote branches: ${branches.err}`);
    else {
      const names = branches.out.split("\n").map(b => b.replace(/^origin\//, ""))
        .filter(b => b && b !== "main" && b !== "HEAD");
      const withWork = names.filter(b => {
        const ahead = run("git", ["rev-list", "--count", `origin/main..origin/${b}`]);
        return ahead.ok && Number(ahead.out) > 0;
      });
      const unopened = unopenedBranches(withWork, heads);
      say("", `branches with commits and no pull request (${unopened.length})`,
          ...unopened.map(b => `  ${b}`));
    }
  }

  if (argv.includes("--sweep")) {
    const dir = mkdtempSync(join(tmpdir(), "reeve-state-sweep-"));
    try {
      const added = run("git", ["worktree", "add", "-q", "--detach", dir, "origin/main"]);
      if (!added.ok) refuse(`could not create the sweep worktree: ${added.err}`);
      else {
        // INSTALL, because the sweep runs the test suite and part of it imports a
        // devDependency. Without this the sweep reports UNRUNNABLE and the report
        // above it says main is broken, which is how this script came to exist.
        const installed = runner(dir)("npm", ["ci", "--no-audit", "--no-fund"], { timeout: 600_000 });
        if (!installed.ok) refuse(`could not install dependencies in the sweep worktree: ${installed.err}`);
        else {
          const swept = runner(dir)("node", ["scripts/stub-sweep.mjs"], { timeout: 3_600_000 });
          const verdict = sweepVerdict(swept);
          say("", `sweep           ${verdict.level}`, ...verdict.lines.map(l => `  ${l}`));
          if (verdict.level === "refusal") refusals++;
        }
      }
    } finally {
      run("git", ["worktree", "remove", "--force", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(out.join("\n"));
  return refusals ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) process.exit(main(process.argv.slice(2)));
