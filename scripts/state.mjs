#!/usr/bin/env node
// What is true right now -- as a SCRIPT, in the repository, rather than as a
// fenced block inside a handoff document.
//
// WHY THIS MOVED. The block it replaces lived in markdown, was re-derived by hand
// each session, and was the first thing a resumed session ran. Nothing tested it,
// nothing linted it, and the stub sweep could not see it. It shipped two defects
// that a resumed session would have read as bad news about a healthy repository,
// and the resume instructions say to STOP when it fails:
//
//   1. `git show <ref>:<path> | grep -m1 PATTERN || note_refusal` -- grep exits at
//      the first match, `git show` takes SIGPIPE, and under `set -o pipefail` the
//      pipeline reports 141. The handler fired on a SUCCESSFUL read. Measured
//      2026-09-02: bash 141, zsh 0, so testing it interactively proved it fine.
//
//   2. The isolated sweep worktree never had dependencies installed, so a test
//      importing `eslint` could not run. The sweep said UNRUNNABLE, the block said
//      the sweep failed, and the conclusion that main was broken was false.
//
// Both are one shape: a guard that alarms on success. Neither is possible here --
// nothing below builds a shell pipeline, so a command's exit status is the only
// status there is.
//
// EVERY READING BELOW IS EITHER A MEASUREMENT OR A REFUSAL, and there is no third
// thing. A read that fails must never reach the reader as an empty answer, because
// empty reads as good news: no unopened branches, no open work, nothing to do.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, openSync, readSync, closeSync, fstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run a command with an argument vector. No shell, so no pipeline to hide a status. */
export function runner(cwd = process.cwd()) {
  return (cmd, args, { timeout = 120_000, env = null } = {}) => {
    try {
      return { ok: true, out: execFileSync(cmd, args, { cwd, encoding: "utf8", timeout,
        ...(env ? { env } : {}),
        maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim() };
    } catch (e) {
      return { ok: false, out: String(e.stdout ?? "").trim(),
               err: (String(e.stderr || e.message).split("\n").filter(Boolean).pop() ?? "failed").slice(0, 200) };
    }
  };
}

/**
 * THE RUNTIME THIS SCRIPT NEEDS, checked before anything reads anything.
 *
 * package.json requires Node >=24.10 for `node:sqlite` to be unflagged, and the
 * shell default on the documented host is v22. The block this replaced prepended
 * the Node 24 path for exactly that reason; a bare shebang inherits PATH and would
 * happily produce a full report under a runtime the suite cannot run on.
 */
export function nodeFloorFailure(version, floor = [24, 10, 0]) {
  const got = String(version).replace(/^v/, "").split(".").map(Number);
  if (got.some(Number.isNaN)) return `cannot read the running Node version from ${version}`;
  for (let i = 0; i < floor.length; i++) {
    if ((got[i] ?? 0) > floor[i]) return null;
    if ((got[i] ?? 0) < floor[i]) return `this script needs Node >=${floor.join(".")} and is running ${version}`;
  }
  return null;
}

/**
 * Arguments, validated.
 *
 * A mistyped `--swep` silently skipping the verification would make an ABSENT
 * gate look like an ordinary clean report -- which is the same shape as every
 * other defect this file exists to prevent.
 */
export function parseArgs(argv) {
  const known = new Set(["--sweep"]);
  const bad = (argv ?? []).filter(a => !known.has(a));
  if (bad.length) return { error: `unknown argument(s): ${bad.join(", ")}. The only option is --sweep` };
  return { sweep: (argv ?? []).includes("--sweep") };
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
 * Whether the launchd job is actually running, from `launchctl print`.
 *
 * A LOG LINE IS NOT A LIVENESS PROOF. `reeve.log` is append-only and the startup
 * record even precedes the daemon's own Node-floor assertion, so a process that
 * started and immediately exited leaves a line that reads exactly like a healthy
 * one. Reporting `daemon running <sha>` from that alone is an absence read as
 * success, indefinitely.
 */
export function daemonPidFrom(launchctlOut) {
  const m = /^\s*pid\s*=\s*(\d+)/m.exec(String(launchctlOut ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * The schema version a source file declares, or null.
 *
 * Takes TEXT, not a command. The defect this replaces was entirely in how the text
 * was fetched, so the fetch is the caller's problem and this cannot repeat it.
 */
export function schemaVersionFrom(sourceText) {
  const m = /HUB_SCHEMA_VERSION\s*=\s*(\d+)/.exec(String(sourceText ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * Branches carrying commits that main does not have, and that no pull request
 * claims.
 *
 * KEYED ON THE HEAD COMMIT, not on the branch name. A name is reused: once a pull
 * request closes, the next branch of the same name would be marked claimed for
 * ever and its commits would never appear here. A fork's pull request also carries
 * a same-named head that has nothing to do with this repository's branch. The
 * commit is the thing that is actually the same or not.
 */
export function unopenedBranches(branches, claimedOids) {
  const claimed = new Set(claimedOids ?? []);
  return (branches ?? []).filter(b => !claimed.has(b.oid));
}

/**
 * What a sweep run MEANS, which is not what its exit code says.
 *
 * A sweep exits non-zero both when an assertion cannot fail -- the finding it
 * exists to produce -- and when a test could not be executed at all. The second is
 * a fact about the machine it ran on, and reporting it as the first is exactly the
 * false alarm this script was written after.
 *
 * BOTH STILL STOP THE CALLER. An entry that could not run produced no evidence, so
 * the verification is incomplete either way; only the SENTENCE differs, because
 * only the sentence tells the operator where to look.
 */
export function sweepVerdict({ ok, out }) {
  if (ok) return { level: "ok", stop: false,
                   lines: [(out ?? "").split("\n").filter(Boolean).slice(-2).join(" | ")] };
  const text = String(out ?? "");
  const unrunnable = [...text.matchAll(/^\s*·\s*(\S+): (UNRUNNABLE|CRASHED|TIMED_OUT)$/gm)].map(m => `${m[1]} ${m[2]}`);
  const uncaught = [...text.matchAll(/^\s*·\s*(\S+): (NOT_CAUGHT|WRONG_RED)$/gm)].map(m => `${m[1]} ${m[2]}`);
  if (uncaught.length) return { level: "refusal", stop: true,
    lines: [`${uncaught.length} assertion(s) cannot fail for the reason they name:`, ...uncaught] };
  if (unrunnable.length) return { level: "environment", stop: true,
    lines: [`the sweep could not RUN ${unrunnable.length} entr(ies) here:`, ...unrunnable,
            "this is a fact about this machine rather than about the code -- check dependencies are installed in the sweep tree",
            "the verification is incomplete either way, so this still stops the caller"] };
  return { level: "refusal", stop: true,
           lines: ["the sweep failed and named no verdict", text.split("\n").slice(-3).join(" | ")] };
}

/**
 * Scan a file BACKWARD for the last line matching `re`, without loading it whole.
 *
 * `reeve.log` is append-only and nothing rotates it, so reading it entirely grows
 * without bound on a long-running install. But a fixed tail is not the fix: the
 * daemon's last START can be older than any window you pick -- measured
 * 2026-09-02, a 256KB tail of a log written since 08-30 contained no startup line
 * at all, and the script correctly but uselessly refused. So the window GROWS
 * until it finds one or reaches the cap, and the cap is a refusal rather than a
 * silent empty answer.
 */
/** Can this path be opened for reading at all? Distinguishes "no log" from "no record in it". */
export function fileReadable(path) {
  try { closeSync(openSync(path, "r")); return true; } catch { return false; }
}

export function lastMatchBackward(path, re, { chunk = 256 * 1024, max = 64 * 1024 * 1024 } = {}) {
  let fd = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    for (let window = Math.min(chunk, size); ; window = Math.min(window * 4, size)) {
      const buf = Buffer.alloc(window);
      readSync(fd, buf, 0, window, size - window);
      const hits = [...buf.toString("utf8").matchAll(re)];
      if (hits.length) return hits[hits.length - 1][1];
      if (window >= size || window >= max) return null;
    }
  } catch { return null; } finally { if (fd !== null) try { closeSync(fd); } catch { /* already gone */ } }
}

// ── the report ────────────────────────────────────────────────────────────────

const REPO = process.env.REEVE_REPO_ROOT ?? join(import.meta.dirname, "..");
const NWO = process.env.REEVE_STATE_REPO ?? "revnix/reeve";

function main(argv) {
  const floor = nodeFloorFailure(process.version);
  if (floor) { console.error(`REFUSES: ${floor}`); return 1; }
  const args = parseArgs(argv);
  if (args.error) { console.error(`REFUSES: ${args.error}`); return 1; }

  const run = runner(REPO);
  const out = [];
  let refusals = 0;
  const say = (...l) => out.push(...l);
  const refuse = (why) => { refusals++; say(`REFUSES: ${why}`); };

  // A FAILED FETCH IS SILENT, and every read below would then answer from the
  // cached remote-tracking ref -- reporting stale state at the moment this exists
  // to re-measure it. `--prune` because a deleted remote branch otherwise keeps its
  // tracking ref and would be reported as live unopened work for ever.
  const fetched = run("git", ["fetch", "origin", "--prune", "--quiet"]);
  if (!fetched.ok) { console.error(`REFUSES: could not fetch origin: ${fetched.err}`); return 1; }

  const branch = process.env.REEVE_DEFAULT_BRANCH ?? "main";
  const mainTip = run("git", ["log", "--oneline", "-1", `origin/${branch}`]);
  mainTip.ok ? say(`${branch.padEnd(15)} ${mainTip.out}`) : refuse(`could not read origin/${branch}: ${mainTip.err}`);

  const head = run("git", ["rev-parse", "--short", "HEAD"]);
  const behind = run("git", ["rev-list", "--count", `HEAD..origin/${branch}`]);
  if (head.ok && behind.ok) say(`this checkout   ${head.out}, ${behind.out} behind origin/${branch}`);
  else refuse(`could not compare this checkout to origin/${branch}: ${head.err ?? behind.err}`);

  // LIVENESS FIRST, then what it loaded. The log alone cannot tell a running
  // daemon from one that started and died.
  const printed = run("launchctl", ["print", `gui/${process.getuid?.() ?? ""}/com.revnix.reeve`]);
  const pid = printed.ok ? daemonPidFrom(printed.out) : null;
  const logPath = join(process.env.REEVE_HOME ?? join(process.env.HOME ?? "", ".reeve"), "reeve.log");
  const logReadable = fileReadable(logPath);
  const running = logReadable ? lastMatchBackward(logPath, /running commit ([0-9a-f]{7,40})/g) : null;
  if (!printed.ok) refuse(`could not ask launchctl about the daemon job: ${printed.err}`);
  else if (pid === null) say("daemon          the job is loaded but NOT running (launchctl reports no pid)");
  else if (!logReadable) refuse("the daemon is running but no log could be read, so what it loaded is unknown");
  else if (running === null) refuse("the daemon is running but its log records no `running commit`");
  else say(`daemon          pid ${pid}, loaded commit ${running}`);

  const src = run("git", ["show", `origin/${branch}:src/build/hubdb.mjs`]);
  if (!src.ok) refuse(`could not read hubdb.mjs from origin/${branch}: ${src.err}`);
  else {
    const v = schemaVersionFrom(src.out);
    v === null ? refuse(`origin/${branch} declares no HUB_SCHEMA_VERSION`)
               : say(`hub schema      ${v} (next migration ${v + 1})`);
  }

  // PAGINATED, and by HEAD OID. `gh pr list --limit N` fetches at most N; it is not
  // pagination, so any cap silently truncates the inventory it is used to build.
  const prJson = run("gh", ["api", "--paginate", `repos/${NWO}/pulls?state=all&per_page=100`,
                            "--jq", ".[]|[.number,.state,.head.ref,.head.sha,.head.repo.full_name]|@tsv"]);
  if (!prJson.ok) refuse(`could not list pull requests: ${prJson.err}`);
  const prs = prJson.ok ? prJson.out.split("\n").filter(Boolean).map(l => {
    const [number, state, ref, sha, repo] = l.split("\t");
    return { number, state, ref, sha, repo };
  }) : null;

  if (prs) {
    const open = prs.filter(p => p.state === "open");
    say("", `open pull requests (${open.length})`, ...open.map(p => `  #${p.number} ${p.ref}`));
  }

  const refs = run("git", ["ls-remote", "--heads", "origin"]);
  if (!refs.ok) refuse(`could not read origin's live branch heads: ${refs.err}`);
  else if (!prs) {
    // THE PREREQUISITE FAILED, SO THE LIST IS OMITTED. Falling back to the open
    // pull requests alone reclassifies every merged branch as unopened work -- in
    // a squash-merged repository that is 136 rows where 8 are real, printed under
    // an authoritative heading. An absent section is honest; a wrong one is not.
    say("", "branches with commits and no pull request: NOT DERIVED, because the pull-request history could not be read");
  } else {
    const claimed = prs.filter(p => p.repo === NWO).map(p => p.sha);
    const heads = refs.out.split("\n").filter(Boolean).map(l => {
      const [oid, ref] = l.split("\t");
      return { oid, name: (ref ?? "").replace("refs/heads/", "") };
    }).filter(b => b.name && b.name !== branch);

    const withWork = [];
    let uncounted = 0;
    for (const b of heads) {
      const ahead = run("git", ["rev-list", "--count", `origin/${branch}..${b.oid}`]);
      // A COMPARISON THAT FAILED IS NOT A ZERO. Dropping it silently presents the
      // remaining list as complete.
      if (!ahead.ok) { uncounted++; continue; }
      if (Number(ahead.out) > 0) withWork.push(b);
    }
    const unopened = unopenedBranches(withWork, claimed);
    say("", `branches with commits and no pull request (${unopened.length})`, ...unopened.map(b => `  ${b.name}`));
    if (uncounted) refuse(`${uncounted} branch(es) could not be compared, so that list is not complete`);
  }

  if (args.sweep) {
    const dir = mkdtempSync(join(tmpdir(), "reeve-state-sweep-"));
    try {
      const added = run("git", ["worktree", "add", "-q", "--detach", dir, `origin/${branch}`]);
      if (!added.ok) refuse(`could not create the sweep worktree: ${added.err}`);
      else {
        // INSTALL, because the sweep runs the suite and part of it imports a
        // devDependency. Without this the sweep reports UNRUNNABLE and the report
        // above it says main is broken, which is how this script came to exist.
        const installed = runner(dir)("npm", ["ci", "--no-audit", "--no-fund"], { timeout: 900_000 });
        if (!installed.ok) refuse(`could not install dependencies in the sweep worktree: ${installed.err}`);
        else {
          // AN EXPLICIT BASE. The worktree IS origin/main, so the sweep's own
          // default base resolves to HEAD and the comparison is empty -- which
          // silently skips the grandfathered-file and manifest-growth gates and
          // still reports ok. Those gates are most of what the sweep is for.
          const swept = runner(dir)("node", ["scripts/stub-sweep.mjs"],
            { timeout: 3_600_000, env: { ...process.env, STUB_SWEEP_BASE: `origin/${branch}~1` } });
          const verdict = sweepVerdict(swept);
          say("", `sweep           ${verdict.level}`, ...verdict.lines.map(l => `  ${l}`));
          if (verdict.stop) refusals++;
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
