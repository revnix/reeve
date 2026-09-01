#!/usr/bin/env node
/**
 * Break the code on purpose, and check the tests notice.
 *
 * Usage:  node scripts/stub-sweep.mjs [name ...]
 *         node scripts/stub-sweep.mjs                 # every stub in the manifest
 *
 * Exit:   0  every stub was CAUGHT by the assertion it names
 *         1  at least one stub was not caught, or could not be measured
 *         2  the sweep refused to run at all
 *
 * The reasoning lives in src/stubsweep.mjs and is tested without a filesystem;
 * this file gathers the facts. Same split as verify-merge.mjs over mergecheck.mjs.
 *
 * Everything this refuses to do, it refuses because doing it cost something:
 *
 *  · it will not run against a DIRTY working tree. A sweep restores between
 *    entries, and a restore cannot tell your uncommitted work from a stub. Running
 *    `git checkout -- src/` mid-sweep with uncommitted fixes present destroyed
 *    them silently, and the next reading measured the absence of the fix.
 *
 *  · it restores from a BYTE COPY taken before stubbing, never from git. `git
 *    checkout` restores to the last commit, which is a different thing from the
 *    tree it was handed.
 *
 *  · it applies edits IN PROCESS. A harness that builds its edits through a shell
 *    string can report a quoting accident as a finding.
 *
 *  · it proves a stub landed by a HASH CHANGE rather than by re-reading the file
 *    for the anchor. Confirmation greps have been measured inert here.
 */
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync, realpathSync, statSync,
         lstatSync, readlinkSync, openSync, readSync, closeSync, fstatSync, constants, readdirSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyEdit, validateManifest, classify, summarise, parsePorcelainZ, fingerprint,
         CAUGHT, UNRUNNABLE, TIMED_OUT_EXIT,
         coverage, coverageLine, changedFiles, grandfatherGate,
         listGrowth, unresolvedAnchors } from "../src/stubsweep.mjs";

// Overridable so the runner can be pointed at a throwaway repository built by its
// own test. The cleanliness guard then applies to THAT tree, so the real one is
// not weakened to make itself testable -- which would be the usual way a guard
// becomes decorative.
const ROOT = process.env.STUB_SWEEP_ROOT
  ? resolve(process.env.STUB_SWEEP_ROOT)
  : resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");

// AT THE TOP, with the other constants, because both of these are read by a guard.
// Both use-before-declaration bugs shipped in this file went into guards, for the
// structural reason that a guard is added early and its helper written later.

function die(code, msg) { console.error(msg); process.exit(code); }

// --- the tree must be clean, and that is not negotiable ----------------------
//
// Checked over the WHOLE tree rather than only the files the manifest names: a
// stub can make a test import something that reads an unrelated file, and a sweep
// that leaves a modified tree behind has poisoned every later reading anyway.
let dirty;
try {
  dirty = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" }).trim();
} catch (err) {
  die(2, `stub-sweep: cannot ask git whether the tree is clean, so it will not risk your work: ${err.message}`);
}
if (dirty)
  // NEVER "STASH". The stash is per-REPOSITORY, not per-worktree, so a pop in one
  // lane can take another lane's work -- and this repository is developed across
  // many worktrees at once, with hooks that stash too. Advice a tool gives at a
  // refusal is followed, so advising the one operation that can lose a
  // colleague's uncommitted work is worse than giving no advice at all.
  //
  // The two safe answers differ by what is dirty, so both are named: an
  // UNTRACKED file has somewhere else to be, and a tracked change wants a
  // commit. `git status --porcelain` marks the untracked ones `??`.
  die(2, "stub-sweep: the working tree has uncommitted changes.\n" +
         "This sweep restores files between entries and cannot tell your work from a stub.\n" +
         "Commit tracked changes, or move untracked files (marked `??`) outside the repository.\n" +
         "Do NOT stash: the stash is shared by every worktree of this repository, so a later\n" +
         "pop can take work belonging to another lane. Refusing rather than risking it:\n" + dirty);

// A SEAM, so the runner can be driven against a manifest built for a test.
// Without it the only way to check that this tool FAILS on an uncaught stub would
// be to break the repository on purpose and look — which is to say, no way at all.
// An instrument that cannot be shown to fail is the exact shape it exists to find.
const KILL_STRATEGY = process.platform === "win32" ? "taskkill"
                    : (process.platform === "darwin" || process.platform === "linux") ? "posix"
                    : null;

// REFUSED, not attempted. A sweep that cannot stop what it spawns can leave a
// worker running against a restored tree — and the tree looks correct afterwards,
// which is the one outcome worse than failing loudly.
if (!KILL_STRATEGY)
  die(2, `stub-sweep: no way to terminate a test's process tree on ${process.platform}.\n` +
         "POSIX uses a process group and taskkill covers Windows; this platform has neither,\n" +
         "so a stubbed test could outlive the sweep and act on a restored tree. Refusing to run.");

const manifestPath = process.env.STUB_MANIFEST
  ? resolve(process.env.STUB_MANIFEST)
  : join(ROOT, "test", "stub-manifest.mjs");
let manifest, grandfathered;
try {
  // A FILE URL, not a path. On win32 `resolve()` yields `C:\\repo\\...`, and
  // `import()` reads `c:` as an unsupported URL scheme — so the taskkill branch
  // above would be reached and the sweep would still refuse to start, for a reason
  // that has nothing to do with what it was checking.
  const mod = await import(pathToFileURL(manifestPath).href);
  manifest = validateManifest(mod.STUBS);
  // From the SAME module object as STUBS, never a second import: the two lists are
  // read together on every path below, and two imports is two chances to read them
  // from different files.
  grandfathered = Array.isArray(mod.GRANDFATHERED) ? mod.GRANDFATHERED : [];
} catch (err) {
  die(2, `stub-sweep: the manifest is not usable: ${err.message}`);
}

// --- a grandfathered file loses its grandfathering the moment it is edited -----
//
// BELOW the manifest load, not above it, because this reads `grandfathered`. Three
// temporal-dead-zone bugs have shipped in this repository and `node --check` cannot
// see one; the first draft of this block sat after the clean-tree check and would
// have been the fourth.
//
// The debt list is not an exemption list. A file on it is tolerated only while
// nobody touches it, because an untouched test is not accruing risk -- the risk
// arrives with the edit, and so does the demand to prove the test can fail. The
// demand therefore lands on the person who already has the file open and knows which
// of its assertions is load-bearing. A deadline would pick files at random, and pick
// them when nobody was looking; the reflex on a deadline is to push it out, which is
// re-grandfathering with extra steps.
// SKIPPED WHEN DRIVEN AGAINST A FIXTURE, and that is not an escape hatch. A tree
// reached through STUB_SWEEP_ROOT is a synthetic repository built by a test: it has
// no default branch, no base, and no grandfather list to be edited. Asking it what
// changed is asking a question its tree cannot answer, and refusing would break the
// sweep's own tests rather than protect anything.
//
// STUB_SWEEP_NO_DIFF is the separate case: THIS repository, genuinely without a base
// to compare against. Two names because they are two different facts, not one fact
// spelled twice -- collapsing them would mean a fixture run and a baseless run could
// not be told apart in the output.
if (!process.env.STUB_SWEEP_ROOT && process.env.STUB_SWEEP_NO_DIFF !== "1") {
  const git = args => {
    try { return { ok: true, out: execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }) }; }
    catch (err) { return { ok: false, err: String(err.stderr ?? err.message).trim().split("\n")[0] }; }
  };
  // The MERGE BASE against the default branch, not HEAD~1: a branch of several
  // commits must be judged on everything it changed, not on its last commit.
  const baseRef = process.env.STUB_SWEEP_BASE || "origin/main";
  const mb = git(["merge-base", baseRef, "HEAD"]);
  const base = mb.ok ? mb.out.trim() : null;
  // A BASE THAT IS HEAD CAN ONLY PRODUCE AN EMPTY DIFF, and in CI that is always a
  // misconfiguration rather than a quiet branch. On a push to the default branch the
  // checkout sets HEAD and origin/main to the SAME commit, so the merge base is HEAD
  // and every direct commit to main -- including one editing a grandfathered file, or
  // adding a new test straight to the list -- sails through a gate that reports
  // success. The workflow supplies the push event's previous commit for exactly this,
  // and this refusal is what stops that configuration being load-bearing.
  //
  // Locally it is benign: standing on a branch with nothing to compare is an ordinary
  // state, not an error, so the refusal is limited to the environment where the sweep
  // is a gate rather than a tool.
  const headSha = git(["rev-parse", "HEAD"]);
  if (process.env.GITHUB_ACTIONS === "true" && base && headSha.ok && base === headSha.out.trim())
    die(2, "stub-sweep: the diff base resolves to HEAD itself, so the change set is empty and this gate\n" +
           "would pass without measuring anything. On a push to the default branch, pass the event's\n" +
           "previous commit as STUB_SWEEP_BASE rather than comparing the checkout to origin/main.");
  const changed = changedFiles({ base, head: "HEAD", run: git });
  if (!changed.ok)
    die(2, `stub-sweep: ${changed.why}\n` +
           "Set STUB_SWEEP_NO_DIFF=1 only if this tree genuinely has no base to compare against.");


  const gate = grandfatherGate({ changed: changed.files, grandfathered });
  if (!gate.ok) die(2, `stub-sweep: ${gate.why}`);

  // THE OTHER HALF OF THE RATCHET. The edit rule refuses touching a listed file and
  // says nothing about a change that drops a test's entry and adds the test to the
  // list instead -- the file is never edited, the diff shows only the manifest, and
  // the list grows while coverage falls. Read the list AS IT WAS at the base and
  // refuse additions.
  //
  // Only when the manifest is in the diff, so the ordinary run pays nothing.
  if (changed.files.includes("test/stub-manifest.mjs")) {
    const was = git(["show", `${base}:test/stub-manifest.mjs`]);
    if (!was.ok)
      die(2, `stub-sweep: the manifest could not be read at the base commit, so whether GRANDFATHERED grew is unknown: ${was.err}`);
    // Parsed rather than imported: importing arbitrary source from another revision
    // executes it, and this runs in the daemon's own repository.
    // WHITESPACE-TOLERANT ON BOTH READS, and they must agree. Matching one exact
    // spacing meant a reformat -- a newline after `const`, a tab, two spaces -- made
    // the contents unreadable AND the presence check answer "absent", so the two
    // failures cancelled and the gate silently reverted to treating the list as newly
    // introduced. A guard whose two halves fail together cannot report the
    // disagreement that makes it safe.
    const block = /export\s+const\s+GRANDFATHERED\s*=\s*\[([\s\S]*?)\]\s*;?/.exec(was.out);
    // ABSENT AND UNREADABLE ARE DIFFERENT ANSWERS. A base that never declared the list
    // is the one-time introduction below. A base that declares one this pattern cannot
    // read -- a wrapped `Object.freeze`, a different terminator, a reformat -- is an
    // unknown, and treating it as absent would skip the growth check silently and for
    // ever after, which is the same "measuring nothing" shape this gate exists to
    // catch. So the IDENTIFIER decides which case it is, and the pattern only reads
    // the contents.
    if (!block && /export\s+const\s+GRANDFATHERED\b/.test(was.out))
      die(2, "stub-sweep: the base commit declares GRANDFATHERED but its contents could not be read,\n" +
             "so whether the list grew is unknown. Refusing rather than skipping the check: an\n" +
             "unreadable prior list would disable this gate permanently and silently.");
    // NO LIST AT THE BASE MEANS THIS CHANGE INTRODUCES IT, and the initial freeze is
    // by definition not growth: there is no earlier list for it to have grown from.
    // Refusing here would mean the change that adds the ratchet cannot pass the
    // ratchet, which is the shape where a guard has to land before its own subject
    // exists. Every later revision has a list at the base, so this branch is taken
    // exactly once in the repository's life.
    //
    // Deleting the list to escape the check is not an opening: `coverage()` reads
    // GRANDFATHERED, and without it every grandfathered file reads as an orphan and
    // the gate fails on that instead.
    if (block) {
      const before = [...block[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      const growth = listGrowth({ before, after: grandfathered });
      if (!growth.ok) die(2, `stub-sweep: ${growth.why}`);
    }
  }
}

// EVERY TARGET MUST RESOLVE INSIDE THE REPOSITORY, checked before anything is
// written and by REAL path, not by string.
//
// `join(ROOT, file)` happily produces a path outside the tree when the entry
// contains `..`, and an in-repository symlink reaches outside without any `..` at
// all. The runner would then snapshot, deliberately modify and restore a file the
// git cleanliness guard cannot see — so a malformed manifest damages a sibling
// project and nothing in the sweep's own safety net notices.
//
// `realpathSync` on the ROOT too, because a repository reached through a symlinked
// parent would otherwise fail its own containment test.
const REAL_ROOT = realpathSync(ROOT);
const contained = file => {
  const target = join(ROOT, file);
  // The FILE may not exist yet in a malformed manifest; resolving its directory is
  // enough to answer where it would be written.
  let real;
  try { real = realpathSync(target); }
  catch { try { real = join(realpathSync(dirname(target)), basename(target)); } catch { return null; } }
  return real === REAL_ROOT || real.startsWith(REAL_ROOT + sep) ? real : null;
};
// The REAL git directory, asked for rather than assumed.
//
// `.git` is a pointer FILE in a worktree and in any repository using a separate
// git directory — measured here: it is 63 bytes, and the metadata lives
// elsewhere. Hard-coding `<root>/.git` therefore excludes a pointer and leaves
// the actual metadata unprotected whenever it sits under an ignored path inside
// the root, where `git status` cannot see a failed restore either.
//
// Both are excluded: the resolved directory, and the literal `.git` entry, which
// is still worth refusing because rewriting the pointer redirects the repository.
let GIT_DIR;
try {
  GIT_DIR = realpathSync(
    execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: ROOT, encoding: "utf8" }).trim());
} catch {
  die(2, "stub-sweep: cannot resolve the git directory, so it cannot be excluded from editable targets.");
}
const GIT_POINTER = join(REAL_ROOT, ".git");
for (const e of manifest)
  for (const ed of e.edits) {
    const real = contained(ed.file);
    if (!real)
      die(2, `stub-sweep: ${e.name}: "${ed.file}" resolves outside the repository.\n` +
             "A manifest may only edit files inside the tree the cleanliness guard can see.");
    // INSIDE the root but INVISIBLE to the guard. `git status` does not report
    // changes to `.git/config`, `.git/index` or anything else under the git
    // directory, so an edit there would be applied, restored and never checked —
    // and a failed restore would corrupt the repository silently.
    if (real === GIT_DIR || real.startsWith(GIT_DIR + sep) ||
        real === GIT_POINTER || real.startsWith(GIT_POINTER + sep))
      die(2, `stub-sweep: ${e.name}: "${ed.file}" is inside the git directory (${GIT_DIR}).\n` +
             "Changes there are invisible to `git status`, so the cleanliness guard could not see a failed restore.");
  }

// --- every anchor must resolve BEFORE any test is run ------------------------
//
// AFTER containment and OUTSIDE the diff block, and both placements are the fix for a
// mistake rather than a preference.
//
// After containment, because this reads file contents: a malformed path resolving to
// an external FIFO or a huge file would block or exhaust the sweep before the guard
// above could refuse it. Containment must decide what may be opened before anything
// opens it.
//
// Outside the diff block, because the first wiring of this put it INSIDE, so every
// fixture-driven run and every legitimately baseless local run skipped the preflight
// entirely and discovered a rotted anchor during the twenty-minute loop -- the exact
// behaviour it exists to prevent, in the change that claimed to prevent it.
//
// TWO SPELLINGS REACHING ONE FILE ARE REFUSED rather than modelled. The runner groups
// by the first TEXTUAL target and applies that target's edits together, so interleaved
// edits through an alias and a real path run in an order this preflight would have to
// reproduce exactly to stay faithful. Refusing the ambiguity is simpler than modelling
// it, and a manifest naming one file two ways is worth refusing on its own terms.
{
  const realOf = new Map();
  for (const e of manifest) {
    const seen = new Map();
    for (const ed of e.edits) {
      // DEVICE AND INODE, which IS filesystem identity. The progression here was
      // normalize, then realpath, then this, and each step was a review round finding
      // an aliasing mechanism the previous one missed -- `./f`, `/f`, a symlink, and
      // finally a HARD LINK, which realpath does not collapse because both names are
      // equally real. There is nothing past dev+ino: two names sharing them ARE one
      // file, and two names not sharing them are not. This ends the family rather
      // than answering one more spelling of it.
      //
      // A file that cannot be stat'd falls back to its path, so a missing file is
      // still REPORTED by the anchor check below rather than throwing here.
      const abs = join(ROOT, ed.file);
      // ONLY a missing file falls back. A bare catch here hid a ReferenceError for an
      // unimported `statSync` and made this whole identity check inert for EVERY file
      // while still printing a plausible result -- the exact shape this pull request
      // exists to remove, inside the change that removes it. A programming error must
      // not be indistinguishable from a file that is not there.
      let real;
      try { const st = statSync(abs); real = `${st.dev}:${st.ino}`; }
      catch (e) {
        // ENOENT and ENOTDIR mean "not there", which the anchor check below reports
        // properly. Any OTHER filesystem error -- ELOOP on a self-referential
        // symlink, EACCES, ENAMETOOLONG -- is a target this sweep cannot read, and
        // that is a REFUSAL rather than a crash: the exit contract reserves 1 for a
        // sweep that ran and 2 for one that would not start, and a rethrow here
        // escapes before the uncaughtException handler is installed, exiting 1 with a
        // stack trace.
        //
        // A programming error still surfaces, because it carries no `code`.
        if (e?.code && e.code !== "ENOENT" && e.code !== "ENOTDIR")
          die(2, `stub-sweep: ${e.name}: "${ed.file}" cannot be read (${e.code}).\n` +
                 "A manifest may only name targets this sweep can open, and refusing is the\n" +
                 "honest answer to one it cannot.");
        if (!e?.code) throw e;
        real = abs;
      }
      const prior = seen.get(real);
      if (prior && prior !== ed.file)
        die(2, `stub-sweep: ${e.name}: "${prior}" and "${ed.file}" name the same file.\n` +
               "The runner groups by the textual target, so two spellings of one file make the\n" +
               "order edits are applied in ambiguous. Name it one way.");
      seen.set(real, ed.file);
      realOf.set(ed.file, real);
    }
  }
  // The KEY is filesystem identity; the READER needs a path. They are different
  // things now, so the reader maps back rather than being handed the key.
  const pathOf = new Map([...realOf].map(([file]) => [realOf.get(file), join(ROOT, file)]));
  const rotted = unresolvedAnchors(manifest, {
    key: f => realOf.get(f) ?? join(ROOT, f),
    read: k => readFileSync(pathOf.get(k) ?? k, "utf8"),
  });
  if (rotted.length)
    die(2, "stub-sweep: these anchors resolve nowhere, so their stubs cannot be placed:\n" +
           // The PATH, never the identity key. Keying by device and inode is right and
    // `16777229:263943751` tells a reader nothing, so the message maps back to the
    // name they wrote in the manifest.
    rotted.map(r => `  ${r.name} -> ${pathOf.get(r.file) ?? r.file}\n    ${String(r.why).split("\n")[0]}`).join("\n") +
           "\n\nRe-anchor them to the text as it now stands. This check costs milliseconds and\n" +
           "runs before any test so a rotted anchor does not cost twenty minutes to discover.");
}

const wanted = process.argv.slice(2);
const entries = wanted.length ? manifest.filter(e => wanted.includes(e.name)) : manifest;
if (wanted.length && entries.length !== wanted.length) {
  const missing = wanted.filter(w => !manifest.some(e => e.name === w));
  die(2, `stub-sweep: no such stub(s): ${missing.join(", ")}`);
}

// ASYNCHRONOUS, and that is what makes the signal handlers work at all.
//
// `spawnSync` blocks the event loop for the whole of the child's life, so a signal
// arriving while a stubbed test runs cannot be delivered to a handler until the
// child exits — up to the full timeout. Anything that escalates to SIGKILL first,
// which `timeout` and a cancelled workflow both do, then kills the process with the
// stub still on disk. The handler was correct and unreachable, which is this
// repository's favourite shape and I had just written a fresh instance of it.
// The child currently under test, so a signal can end it. Without this the
// handler restores the tree and exits while the test keeps running — and its
// timeout timer dies with the parent, so it can continue indefinitely, producing
// side effects after the sweep has reported that it finished.
let activeChild = null;

/**
 * Every descendant of a pid, collected BEFORE anything is killed.
 *
 * The process group covers the ordinary case, and it does not cover a descendant
 * that started a group of its own — a helper spawned with `detached: true` leaves
 * the group and survives a signal aimed at it. So the tree is walked as well.
 *
 * Collected first because the links vanish with the parent: once it dies its
 * children are reparented and `pgrep -P` can no longer find them from here.
 *
 * Best effort, and named as such. `pgrep` exists on macOS and Linux and not on
 * Windows, so this is a second net rather than the mechanism — the group kill
 * remains the thing that does the work.
 */
const descendantsOf = pid => {
  const found = [];
  const walk = p => {
    let out = "";
    try { out = execFileSync("pgrep", ["-P", String(p)], { encoding: "utf8" }); }
    catch { return; }               // no children, or no pgrep on this platform
    for (const line of out.split("\n")) {
      const kid = Number(line.trim());
      if (Number.isInteger(kid) && kid > 0 && !found.includes(kid)) { found.push(kid); walk(kid); }
    }
  };
  walk(pid);
  return found;
};

/**
 * Kill a test and everything it started — by a strategy this PLATFORM supports.
 *
 * The POSIX mechanism does not exist on Windows. `detached` there means a separate
 * console rather than a process group, negative-pid signalling is not supported at
 * all, and `pgrep` is absent — so neither the mechanism nor the net is available,
 * and a best-effort attempt would leave a worker alive on a restored tree while
 * reporting success. That is the failure this whole runner exists to prevent,
 * arriving on a different axis: the tree looks correct afterwards.
 *
 * So the platform matrix is explicit and FAILS CLOSED. `taskkill /T /F` walks the
 * tree itself on Windows; POSIX uses the group plus the descendant sweep; anything
 * else refuses at start-up rather than running with no way to stop what it spawns.
 *
 * Raised by the session building the provider-session extraction, whose harness
 * spawns real workers and hits the same wall.
 */

/**
 * WHAT THIS DOES NOT DO, because the boundary matters more than the effort.
 *
 * It ends a test the sweep is still holding — on a signal or a timeout — so the
 * tree is never left stubbed. It does NOT supervise what a test spawns.
 *
 * A worker started by a test that then exits NORMALLY survives, and cannot
 * reliably be stopped from here. Measured rather than assumed: after the child
 * exits, `process.kill(-pgid)` returns ESRCH and `pgrep -g <pgid>` finds nothing;
 * sampling `pgrep -P` while the child lives DOES return the worker's real pid, and
 * `process.kill(<that pid>, "SIGKILL")` then returns ESRCH anyway while the worker
 * demonstrably survives and writes seconds later. That last reading is unexplained,
 * and a guarantee built on a mechanism nobody understands is worse than no
 * guarantee, because it invites reliance.
 *
 * A sampling loop was written and removed. It cost a `pgrep` every 50ms of every
 * test run — thousands of process spawns per sweep, paid in CI on every push — to
 * deliver a property it could not keep. Applying a stub, reading a verdict and
 * restoring the tree is this tool's job; process supervision belongs to whoever
 * wrote the test, or to a sandbox.
 *
 * The tree checks remain the backstop, and their limit is honest too: they read
 * after the test exits, so a worker writing later is outside what a synchronous
 * sweep can see.
 */
const killTree = child => {
  if (!child?.pid) return;
  if (KILL_STRATEGY === "taskkill") {
    // `/T` is the tree and `/F` is forceful. taskkill walks the descendants
    // itself, so there is no separate straggler pass to do.
    try { execFileSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" }); }
    catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
    return;
  }
  // Collected BEFORE anything dies: the links vanish with the parent.
  const stragglers = descendantsOf(child.pid);
  try { process.kill(-child.pid, "SIGKILL"); }
  catch { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
  // Anything that left the group by starting one of its own. Sent after the group
  // kill, so the ordinary case costs one signal and this is only cleanup.
  for (const pid of stragglers) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone, or not ours */ }
  }
};

const runTest = (file, expectRed = null) => new Promise(resolve => {
  // DETACHED, so the child leads its own process GROUP.
  //
  // Killing the direct pid leaves anything it spawned alive — and a helper that
  // outlives the sweep keeps producing side effects against a tree that has since
  // been restored, with no timer left anywhere to stop it. A group can be killed
  // whole, which is the only way to end work we did not start ourselves.
  const child = spawn(process.execPath, [join(ROOT, file)], { cwd: ROOT, detached: true });
  activeChild = child;
  // BOUNDED. A deliberately broken test that logs continuously would otherwise
  // grow one unbounded string for as long as the timeout allows, and exhausting
  // the sweep's heap kills it before the timer or the restore handlers run —
  // leaving the target stubbed, which is the failure this runner exists to
  // prevent. The pipes are still drained, because not reading them would block
  // the child instead; only what is RETAINED is capped.
  const CAP = 1 << 20;   // 1 MiB of tail is far more than any verdict needs
  let out = "";
  let dropped = 0;
  // ASSERTION LINES ARE KEPT SEPARATELY, and this is not belt-and-braces.
  //
  // A test that prints its named FAIL and THEN emits a megabyte of diagnostics
  // would have had the evidence scrolled out of the tail — and the entry would be
  // reported CRASHED or WRONG_RED, failing the sweep even though the assertion did
  // catch the stub. The verdict must not depend on how noisy the failure was.
  //
  // Bounded too, so a test printing a million assertion lines cannot exhaust the
  // heap through this route instead.
  const ASSERTION_LINE = /^(PASS|FAIL) {2}(.+)$/;
  const MAX_ASSERTION_LINES = 20_000;
  // A BYTE BUDGET as well as a count. `MAX_LINE` truncates only the incomplete
  // tail, so twenty thousand COMPLETE 64 KiB failure lines are each retained whole
  // — over a gigabyte, and the heap goes before the restore handlers run. Which
  // leaves the stub on disk: the same failure the cap exists to prevent, now
  // arriving through the list that was added to preserve evidence from it.
  const MAX_ASSERTION_BYTES = 4 << 20;   // 4 MiB of failure names is far past useful
  let keptBytes = 0;
  // A LINE HAS A MAXIMUM LENGTH. Without one, a test emitting a long diagnostic
  // with no newline grows the incomplete-line buffer for ever — it never reaches
  // the split, so the `out` cap never sees it, and the heap goes before the timer
  // or the restore handlers run. Which leaves the stub on disk: the exact failure
  // the cap was added to prevent, arriving through the buffer that implements it.
  const MAX_LINE = 1 << 16;
  // FAIL lines ONLY spend the budget. A large suite printing twenty thousand
  // passing assertions before the relevant failure would otherwise exhaust the
  // budget on PASS lines, and the named FAIL — the one thing this exists to
  // preserve — would still scroll out of the tail.
  const kept = [];
  let namedKept = false;
  // THE VERDICT'S EVIDENCE, counted as each line arrives and never evicted.
  //
  // `kept` is a RETENTION buffer with a budget, so anything derived from it is a
  // statement about what survived rather than about what the run reported. Three
  // separate defects came from that single confusion. These three fields are the
  // verdict's inputs; `kept` is only what a human reads afterwards.
  // COUNTED, not merely noticed. `anyAssertionSeen` was a boolean, so a run that
  // reported the named failure and then DIED partway satisfied it exactly as a
  // complete run does -- and `classify` had no other input that could tell them
  // apart. Three such runs were found by hand in one morning; each reported
  // CAUGHT while proving a fraction of what its entry claimed. A boolean is a
  // count with its threshold pinned at one, which is where it catches nothing.
  // NAMES AS WELL AS A COUNT, and a multiset rather than a set.
  //
  // A total alone can be satisfied by a stub that ADDS assertion lines -- one
  // that widens a loop, say -- while skipping later ones, which is the same
  // false green the count exists to stop, reached from the other side. What the
  // verdict actually needs to know is whether every assertion the CONTROL
  // reported was reported again, and counts per name answer that even when a
  // name repeats inside a loop.
  //
  // BOUNDED, and the bound is recorded rather than silently applied: a truncated
  // list cannot answer the question, so `classify` falls back to the total
  // instead of reading absence as a missing assertion.
  const MAX_TRACKED_NAMES = 20_000;
  const observed = { assertionsSeen: 0, namedFailSeen: false, failures: [],
                     names: new Map(), namesTruncated: false };
  // Enough failures to diagnose a WRONG_RED and not enough to matter. The named
  // failure's PRESENCE is recorded separately, so this bound cannot change a verdict.
  const MAX_REPORTED_FAILURES = 50;
  // ONE INGESTION SITE for both the streaming path and the close-time tails.
  // The rules -- truncation, the named reservation, the budget, FAIL-only
  // retention -- were applied at two places and each received a different subset,
  // which is where three of one review round's findings came from. A rule added
  // here now lands everywhere by construction rather than by remembering.
  const ingest = raw => {
    const l = raw.length > MAX_LINE ? raw.slice(0, MAX_LINE) : raw;
    const m = ASSERTION_LINE.exec(l);
    if (!m) return;
    // A PASS IS AN ASSERTION RESULT. Counting it is what stops a run that reported
    // only passes, then exited non-zero, from being read as a crash -- and it is
    // counted without being retained, because the budget is for evidence a human
    // reads and not for the verdict.
    observed.assertionsSeen++;
    const name = m[2].trim();
    // A PASS is counted here too: the question is which assertions RAN, and a
    // control's passing assertion vanishing under a stub is exactly the loss
    // this is looking for.
    if (observed.names.has(name)) observed.names.set(name, observed.names.get(name) + 1);
    else if (observed.names.size < MAX_TRACKED_NAMES) observed.names.set(name, 1);
    else observed.namesTruncated = true;
    if (m[1] !== "FAIL") return;
    // KEYED ON FAIL, not on the line matching the protocol at all. A passing
    // assertion whose name contains the expected text used to consume the slot
    // reserved for the failure, and the failure then scrolled out of the tail.
    const isNamed = Boolean(expectRed) && name.includes(expectRed);
    if (isNamed) observed.namedFailSeen = true;
    if (observed.failures.length < MAX_REPORTED_FAILURES) observed.failures.push(name);
    if (isNamed && !namedKept) { kept.push(l); namedKept = true; return; }
    if (kept.length < MAX_ASSERTION_LINES && keptBytes < MAX_ASSERTION_BYTES) {
      kept.push(l);
      keptBytes += l.length;
    }
  };
  // ONE BUFFER PER STREAM. A shared one splices stderr into a stdout assertion
  // split across chunks: `FAIL  guard` + `diagnostic\n` + ` holds\n` retains a
  // line that never existed, and the assertion that did is lost.
  const partial = { out: "", err: "" };
  const take = which => d => {
    const merged = partial[which] + d;
    const lines = merged.split("\n");
    let tail = lines.pop() ?? "";
    // A line longer than the maximum is TRUNCATED rather than buffered. It cannot
    // be an assertion — the protocol's names are short — and keeping the head is
    // more useful than keeping nothing.
    if (tail.length > MAX_LINE) tail = tail.slice(0, MAX_LINE);
    partial[which] = tail;
    // BRACED. This loop had a single-statement body, so adding a second block
    // silently placed it OUTSIDE the loop, where the line variable does not exist.
    for (const l of lines) ingest(l);
    out += d;
    if (out.length > CAP) { dropped += out.length - CAP; out = out.slice(-CAP); }
  };
  child.stdout.on("data", take("out"));
  child.stderr.on("data", take("err"));
  const timer = setTimeout(() => { timedOut = true; killTree(child); }, 600_000);
  let timedOut = false;
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    // A killed child is reported as its own thing rather than coerced, because
    // "timed out" and "failed an assertion" are different readings and only one of
    // them is evidence.
    activeChild = null;
    // THE SAME INGESTION as every other line. These tails used to be handled by a
    // second copy of the rules that had the budget but not the named reservation,
    // so an expected FAIL arriving last and unterminated was discarded once earlier
    // failures had filled the budget -- and, the raw body being deliberately inert,
    // the run then read WRONG_RED for a stub whose named assertion had fired.
    for (const tail of [partial.out, partial.err]) if (tail) ingest(tail);
    // The kept assertions come FIRST, so they survive whatever the tail lost. The
    // classifier reads whole lines, so prepending them changes nothing it can see
    // except that the evidence is present.
    // THE RAW BODY IS MADE INERT, not merely deprioritised.
    //
    // It is the two streams interleaved as they arrived, so a line can appear in
    // it that neither stream ever emitted: stdout writes `FAIL  wrong assertion`
    // with no newline, stderr writes ` target expected\n`, and the concatenation
    // reads as one forged assertion naming the expected text. The classifier would
    // then report CAUGHT for a run whose real assertions say otherwise.
    //
    // Indenting every raw line by two spaces means none of them can match the
    // assertion protocol's `^(PASS|FAIL) {2}` anchor, so the raw text survives for
    // a human to read while being unclassifiable. The reconstructed per-stream
    // lines, prepended unindented, are the only thing the classifier can see.
    const raw = (dropped ? `[${dropped} earlier byte(s) dropped]\n${out}` : out)
      .split("\n").map(l => `  ${l}`).join("\n");
    const body = raw;
    // ALWAYS prepended, not only when the tail overflowed.
    //
    // `out` is the two streams interleaved as they arrived, so an assertion split
    // across stdout chunks with a stderr line landing between them appears there
    // spliced and broken — a line that never existed, while the one that did is
    // absent. The per-stream reconstruction is the correct reading whether or not
    // anything was dropped, so it is the one the classifier gets.
    // `observed` TRAVELS WITH THE RUN. Leaving it off resolved cleanly, handed
    // `classify` an undefined it is documented to fall back from, and made the whole
    // counting path inert while every one of its own unit assertions still passed --
    // the seam existed and nothing was plugged into it. What found it was a stub on
    // the counter reading NOT_CAUGHT; the suite could not have, because both paths
    // return the same verdict when the new one is unused.
    resolve({ exit: timedOut || code === null ? TIMED_OUT_EXIT : code,
              observed,
              output: kept.length ? `${kept.join("\n")}\n${body}` : body });
  });
});

// --- restore on the way out, however we leave -------------------------------
//
// The docblock above claimed a killed run cannot leave a stub behind. Taking the
// snapshot is what makes that possible; it is not what makes it true. Without
// these handlers a Ctrl-C, a `timeout`, or a cancelled workflow exits between
// writing the stub and restoring it, leaving a DELIBERATELY BROKEN production file
// in the tree — and the next sweep then refuses to run because the tree is dirty,
// which reads as the guard working when it is really the wreckage of the last run.
//
// `active` is set before the first byte is written and cleared only after a
// verified restore, so a handler firing at any other moment has something to undo
// and a handler firing after a clean run has nothing.
let active = null;
const restoreActive = () => {
  if (!active) return;
  // Synchronous on purpose: an exit handler cannot await, and this has to finish
  // before the process goes.
  const failed = [];
  const left = [];
  for (const [f, snap] of active.snaps) {
    // ONLY what is still exactly the stub we wrote.
    //
    // Copying unconditionally recreates a file the test or a person DELETED
    // during the run, silently undoing it — and overwrites a save made in the
    // same window. A stub we can no longer recognise is not ours to replace; say
    // where the original is and leave it.
    let now = null;
    try { now = createHash("sha256").update(readFileSync(f)).digest("hex"); } catch { now = null; }
    if (active.stubbed && active.stubbed.get(f) !== undefined && now !== active.stubbed.get(f)) {
      left.push([f, snap.copy, now === null ? "it was deleted during the run" : "it changed during the run"]);
      continue;
    }
    try { copyFileSync(snap.copy, f); } catch (err) { failed.push([f, snap.copy, err.message]); }
  }
  if (left.length) {
    console.error("stub-sweep: left alone, because these are no longer the stub this run wrote:");
    for (const [f, copy, why] of left) console.error(`  ${f}\n    ${why}\n    the pre-sweep original is at: ${copy}`);
  }
  if (failed.length) {
    // KEEP THE SNAPSHOTS. Deleting them here would destroy the only copy of the
    // original while the deliberately broken file is still in the tree, and then
    // report that restoration happened. Say where they are instead: a person can
    // finish by hand, and cannot if the evidence is gone.
    console.error("stub-sweep: COULD NOT RESTORE. The broken file is still in your tree.");
    for (const [f, copy, why] of failed) console.error(`  ${f}\n    restore from: ${copy}\n    because: ${why}`);
    active = null;
    return;
  }
  try { rmSync(active.dir, { recursive: true, force: true }); } catch { /* the tree is right; the temp dir is not worth failing over */ }
  active = null;
};
process.on("exit", restoreActive);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    // The CHILD first. It is holding the stubbed tree open, and killing it after
    // restoring would let it run on against files that no longer match what it
    // was started with.
    // The group AND anything that left it. Wrapped, so a failure here cannot stop
    // the restore below — a stubbed tree left behind is worse than a stray process.
    try { killTree(activeChild); } catch { /* the restore matters more */ }
    restoreActive();
    console.error(`\nstub-sweep: ${sig} — the tree was restored before exiting.`);
    // The conventional 128+n, so a caller can tell a signal from a verdict.
    process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129);
  });
}
// An unexpected throw is the same situation arriving by a different door.
process.on("uncaughtException", err => {
  restoreActive();
  console.error(`stub-sweep: ${err?.stack ?? err}`);
  process.exit(2);
});

/**
 * Is the tree clean? Returns "" for clean, the porcelain text for dirty, and NULL
 * for could-not-tell.
 *
 * The third case is the point. Swallowing a failed `git status` into the empty
 * string makes "the tree is clean" and "I could not find out" the same answer —
 * and a stubbed test that damaged repository metadata is precisely the case where
 * the check fails, so the one reading that most needs to be believed is the one
 * that silently becomes a pass.
 */
const treeState = () => {
  // `--ignored` as well, and the two halves are read differently.
  //
  // A control run that creates an IGNORED cache — a build artifact, a database,
  // anything in .gitignore — which the stubbed run then consumes and removes is
  // invisible to a plain `git status`: clean before, clean after, and the stub
  // reported CAUGHT for a run that would not have been caught from a genuinely
  // untouched tree. This repository ignores exactly that kind of artifact.
  //
  // Tracked entries must be ABSENT. Ignored entries only have to be UNCHANGED —
  // requiring none would fail on `node_modules` every time, which is not dirt.
  // `--ignored` collapses whole directories to one line, so this stays cheap.
  try {
    // `-z`, NOT the human-readable form. Porcelain v1 C-QUOTES any path holding a
    // space, quote, backslash or non-ASCII byte -- `!! "foo cache"` -- and the
    // quoted string is not the filesystem path. The stat then fails, the entry
    // fingerprints as `<unreadable>` in EVERY reading, and a control run
    // overwriting that file is invisible exactly as it was before fingerprinting.
    // `-z` emits raw bytes with NUL terminators, so there is no quoting to undo.
    // NO `encoding`, so this comes back as a Buffer. Decoding here would undo the
    // whole point of asking for `-z`; see `parsePorcelainZ`.
    const raw = execFileSync("git", ["status", "--porcelain", "-z", "--ignored"],
                             { cwd: ROOT, maxBuffer: 1 << 28 });
    const lines = parsePorcelainZ(raw);
    // IGNORED ENTRIES ARE FINGERPRINTED, not merely listed.
    //
    // A path list cannot see a control run OVERWRITING an ignored artifact that
    // already existed: all three readings carry the same `!! path`, so the stub is
    // applied to altered state and can read CAUGHT for a run that would not have
    // been caught from the untouched tree.
    //
    // What a fingerprint IS, and the directory limit it carries, is stated once at
    // `fingerprint` rather than restated here. A second copy drifts from the first,
    // and the drifted copy is the one somebody reads.
    // The absolute path is BUILT AS BYTES too. `join` would coerce the path to a
    // string and put the replacement characters back, which is the defect this
    // whole route exists to avoid.
    const abs = p => Buffer.concat([Buffer.from(ROOT + sep), p]);
    const ignored = lines.filter(e => e.xy === "!!")
      .sort((a, b) => Buffer.compare(a.path, b.path))
      .map(e => `${e.line} ${fingerprint(abs(e.path))}`).join("\n");
    return {
      tracked: lines.filter(e => e.xy !== "!!").map(e => e.line).join("\n"),
      ignored,
    };
  } catch { return null; }
};

const results = [];
for (const entry of entries) {
  const files = [...new Set(entry.edits.map(e => join(ROOT, e.file)))];

  // Read BEFORE the control as well, so a change the CONTROL makes is visible.
  //
  // Two readings could only compare the stubbed run against the post-control tree,
  // which makes an artifact the control created part of the baseline — and that is
  // exactly the case: a control run that leaves an ignored cache changes what the
  // stubbed run does, and comparing only the later pair calls it unchanged.
  const atEntry = treeState();
  if (atEntry === null) {
    const why = "the repository's state could not be read before this entry, so nothing after it would be verified";
    results.push({ name: entry.name, reintroduces: entry.why, verdict: UNRUNNABLE, why });
    console.log(`FAIL ${entry.name.padEnd(28)} ${UNRUNNABLE}`);
    console.log(`       ${why}`);
    break;
  }

  const control = await runTest(entry.test, entry.expectRed);

  // STOP HERE if the control already fails. `classify` would return UNRUNNABLE
  // whatever happens next, so stubbing production files and waiting out a second
  // timeout buys nothing — and it runs deliberately broken code for up to ten
  // minutes to learn something already known.
  if (control.exit !== 0) {
    const why = control.exit === TIMED_OUT_EXIT
      ? "the test timed out BEFORE stubbing, so nothing it reports afterwards means anything"
      : `the test does not pass before stubbing (exit ${control.exit}), so nothing it reports afterwards means anything`;
    // `reintroduces` rather than a second `why`: the entry's reason and the
    // verdict's reason are two different facts, and an object literal with the key
    // twice silently keeps only the last.
    results.push({ name: entry.name, reintroduces: entry.why, verdict: UNRUNNABLE, why });
    console.log(`FAIL ${entry.name.padEnd(28)} ${UNRUNNABLE}`);
    console.log(`       reintroduces: ${entry.why}`);
    console.log(`       ${why}`);
    continue;
  }

  // CLEAN AFTER THE CONTROL, BEFORE THE STUB. This window and not another.
  //
  // The start-up guard proved the tree was clean when the SWEEP began, which is a
  // different claim from "clean when this stub was applied". A control run that
  // leaves an untracked cache changes what the stubbed run does — and if the
  // stubbed run then consumes and deletes it, the post-entry check sees a clean
  // tree and reports CAUGHT for a stub that would not have been caught from a
  // genuinely clean start.
  //
  // Checking before the control instead would have missed exactly that: the
  // control is what makes the mess.
  const beforeStub = treeState();
  if (beforeStub === null || beforeStub.tracked !== "" || beforeStub.ignored !== atEntry.ignored) {
    const why = beforeStub === null
      ? "the repository's state could not be read after the control run, so this reading would be unverified"
      : beforeStub.tracked !== ""
      ? `the control run left the tree dirty, so the stub would not be applied to a clean tree:\n${beforeStub.tracked}`
      : `the control run changed an IGNORED artifact, which a plain status call cannot see:\n` +
        `  before: ${atEntry.ignored || "(none)"}\n  after:  ${beforeStub.ignored || "(none)"}`;
    results.push({ name: entry.name, reintroduces: entry.why, verdict: UNRUNNABLE, why });
    console.log(`FAIL ${entry.name.padEnd(28)} ${UNRUNNABLE}`);
    console.log(`       ${why}`);
    break;   // the tree is not what anyone intended; later readings are void too
  }

  // Snapshot BEFORE touching anything, and restore from these copies. A run killed
  // partway then cannot leave a stub behind for the next reading to measure.
  const snapDir = mkdtempSync(join(tmpdir(), "stub-sweep-"));
  const snaps = new Map();
  for (const f of files) {
    const to = join(snapDir, createHash("sha256").update(f).digest("hex"));
    copyFileSync(f, to);
    snaps.set(f, { copy: to, hash: sha(f) });
  }
  // Armed BEFORE the first write, so there is no window in which a stub exists
  // and nothing knows how to undo it.
  // `stubbed` is filled in once the edits are written; until then it is empty and
  // the handlers restore unconditionally, which is right — nothing else can have
  // touched the files yet.
  active = { snaps, dir: snapDir, stubbed: new Map() };

  let applyError = null;
  let hashChanged = false;
  const stubbedHashes = new Map();
  try {
    for (const f of files) {
      const edits = entry.edits.filter(e => join(ROOT, e.file) === f);
      let src = readFileSync(f, "utf8");
      for (const ed of edits) src = applyEdit(src, ed);
      writeFileSync(f, src);
    }
    // Proof the stub landed, independent of the anchors that placed it.
    hashChanged = files.some(f => sha(f) !== snaps.get(f).hash);
    for (const f of files) { const h = sha(f); stubbedHashes.set(f, h); active.stubbed.set(f, h); }
  } catch (err) {
    applyError = err;
  }

  // Restored and reported WITHOUT running the test: a partially applied stub is
  // not a configuration anything can be learned from.
  if (applyError) {
    for (const [f, snap] of snaps) { try { copyFileSync(snap.copy, f); } catch { /* reported below */ } }
    const back = files.every(f => { try { return sha(f) === snaps.get(f).hash; } catch { return false; } });
    active = null;
    rmSync(snapDir, { recursive: true, force: true });
    results.push({ name: entry.name, reintroduces: entry.why, verdict: UNRUNNABLE,
                   why: `the stub could not be applied: ${applyError.message}` +
                        (back ? "" : " — AND the tree could not be restored; check it by hand") });
    console.log(`FAIL ${entry.name.padEnd(28)} ${UNRUNNABLE}`);
    console.log(`       ${applyError.message}`);
    continue;
  }

  const stub = await runTest(entry.test, entry.expectRed);

  // THE FILE MUST STILL BE THE STUB WE WROTE.
  //
  // The cleanliness check at start-up cannot protect work created AFTER the
  // snapshot, and a stubbed test can hold the tree for up to ten minutes. If an
  // editor saved over one of these files in that window, copying the snapshot back
  // silently destroys real work — the same class of loss as `git checkout`
  // restoring to the last commit, which is what this whole mechanism replaced.
  // A MISSING file counts as meddling, and this is the P1 it closes. `sha` throws
  // ENOENT on a target the test deleted, the `uncaughtException` handler then runs
  // `restoreActive`, and the snapshot RECREATES the file — silently undoing a
  // deletion someone meant. Unreadable is the same case: what we cannot compare we
  // must not overwrite.
  const readable = f => { try { return sha(f); } catch { return null; } };

  // When the APPLY failed partway, `stubbedHashes` was never populated, so every
  // file compared as meddled and the ones already written were left stubbed with
  // the tree dirty. A failed apply is our own mess and is restored from the
  // snapshots unconditionally.
  const meddled = files.filter(f => readable(f) !== stubbedHashes.get(f));
  if (meddled.length) {
    console.error("stub-sweep: a file changed while its stubbed test was running; NOT overwriting it.");
    for (const f of meddled) console.error(`  ${f}\n    the pre-sweep original is at: ${snaps.get(f).copy}`);
    active = null;   // the handlers must not overwrite it either
    results.push({ name: entry.name, reintroduces: entry.why, verdict: UNRUNNABLE,
                   why: `${meddled.join(", ")} changed during the run, so the tree was left alone and this reading is void` });
    console.log(`FAIL ${entry.name.padEnd(28)} ${UNRUNNABLE}`);
    continue;
  }

  for (const [f, s] of snaps) copyFileSync(s.copy, f);
  const restored = files.every(f => sha(f) === snaps.get(f).hash);
  // Disarmed only once the restore is VERIFIED. A failed restore leaves the
  // handlers armed, so the exit path tries once more rather than walking away
  // from a tree it knows is wrong.
  if (restored) { active = null; rmSync(snapDir, { recursive: true, force: true }); }

  // `observed` is what the STUBBED run reported, counted line by line as it arrived.
  // `stubOutput` still goes with it, but only so the human-facing text has something
  // to quote; nothing in the verdict is derived from it any more.
  // THE CONTROL'S COUNT TRAVELS TOO. It is the only thing that knows how many
  // assertions this file reports on this tree, and without it a stubbed run that
  // stopped early is indistinguishable from one that ran to the end.
  const verdict = classify({ controlExit: control.exit, stubExit: stub.exit, stubOutput: stub.output,
                             observed: stub.observed, controlObserved: control.observed,
                             hashChanged, restored, expectRed: entry.expectRed });

  // THE WHOLE TREE, rechecked after every entry.
  //
  // The startup guard proves the tree was clean when the sweep began; it cannot see
  // what deliberately broken code did while it ran. A stubbed test that writes a
  // file, or modifies one outside the manifest's targets, leaves the repository
  // dirty — and the entry would still report CAUGHT and exit 0, while every
  // FOLLOWING entry runs against a tree nobody intended.
  //
  // Reported as UNRUNNABLE rather than as a failure of the stub: the reading itself
  // is void, because the code under test was not the code in the manifest.
  const after = treeState();
  if (after === null) {
    // COULD NOT TELL is not clean. A stubbed test that damaged repository metadata
    // is exactly the case where this read fails, so treating the failure as a pass
    // hands the benefit of the doubt to the one situation least entitled to it.
    const why = "the repository's state could not be read after the stubbed run, so this reading is unverified";
    results.push({ name: entry.name, reintroduces: entry.why, verdict: UNRUNNABLE, why });
    console.log(`FAIL ${entry.name.padEnd(28)} ${UNRUNNABLE}`);
    console.log(`       ${why}`);
    break;
  }
  // Tracked dirt, OR a change to what is ignored. The second is the case a plain
  // `git status` cannot see, and it is compared against the reading taken just
  // before the stub rather than against emptiness.
  const ignoredChanged = after.ignored !== beforeStub.ignored;
  if (after.tracked || ignoredChanged) {
    console.error(`stub-sweep: ${entry.name} left the repository dirty; the stubbed test had side effects.`);
    console.error(after.tracked || `ignored artifacts changed:\n  before: ${beforeStub.ignored}\n  after:  ${after.ignored}`);
    results.push({ name: entry.name, reintroduces: entry.why, verdict: UNRUNNABLE,
                   why: "the stubbed test modified the repository outside its manifest targets, " +
                        "so this reading is void and later entries would run against a different tree" });
    console.log(`FAIL ${entry.name.padEnd(28)} ${UNRUNNABLE}`);
    break;   // stop: every later reading is now suspect
  }

  results.push({ name: entry.name, reintroduces: entry.why, ...verdict });
  const mark = verdict.verdict === CAUGHT ? "ok  " : "FAIL";
  console.log(`${mark} ${entry.name.padEnd(28)} ${verdict.verdict}`);
  if (verdict.verdict !== CAUGHT) {
    console.log(`       reintroduces: ${entry.why}`);
    console.log(`       ${verdict.why}`);
  }
}

const s = summarise(results);
console.log(`\n${s.caught}/${s.total} stub(s) caught by the assertion they name.`);
// THE RATIO, on every run. Measured 2026-08-30: 48 entries over 3 of 106 test files,
// 26 of them on the sweep's own test -- and nobody had ever seen that number, because
// the output answered "did every entry hold" and everyone let that stand in for "is
// this instrument broad". A number that exists only inside a function cannot prompt
// anyone to fix it.
{
  const testFiles = readdirSync(join(ROOT, "test"))
    .filter(f => f.endsWith(".test.mjs")).map(f => "test/" + f);
  // Only a run that covered the WHOLE manifest can say how many entries are proven;
  // a subset run knows nothing about the ones it did not attempt, and reporting its
  // count as the ratio would understate rather than overstate.
  const whole = entries.length === manifest.length;
  // The CAUGHT entries themselves, not just how many: the file-level count needs to
  // know WHICH tests have a working guard, and a count cannot say that.
  const provenEntries = whole
    ? results.filter(r => r.verdict === CAUGHT)
             .map(r => manifest.find(e => e.name === r.name))
             .filter(Boolean)
    : null;
  const cov = coverage(manifest, testFiles, grandfathered, provenEntries);
  console.log(coverageLine(cov, whole ? s.caught : null));
  // AN ORPHAN IS THE FAILURE, and until now it was only the printed number.
  //
  // `coverage` has always classified a test file that is neither covered nor
  // grandfathered as an orphan, and its own comment calls that the failure -- a
  // test nobody has shown can fail, and that nobody declared. Nothing read it.
  // The exit was the entry verdicts alone, so a new test file with no entry
  // arrived silently and the ratio moved by one where nobody was looking.
  //
  // A rule stated in a comment and not wired is the shape this instrument exists
  // to find, so it should not have been the shape of the instrument.
  //
  // ONLY ON A WHOLE RUN. A targeted run knows the same fact, but failing it for
  // a file the operator did not ask about turns `stub-sweep.mjs one-entry` into
  // a gate that refuses for unrelated reasons -- which is how a tool people use
  // while working becomes one they stop using. CI runs the whole manifest.
  if (whole && cov.orphans.length) {
    console.log("\nThese test files have no manifest entry and are not grandfathered:");
    for (const f of cov.orphans) console.log(`  ${f}`);
    console.log("\nA test nobody has shown can fail is a test that cannot report a defect.");
    console.log("Add an entry naming one of its assertions and the edit that makes it fail.");
    console.log("Grandfathering is for files that predate the rule; a NEW file does not qualify.");
    process.exit(1);
  }
}
if (!s.ok) {
  console.log("\nA stub that is not caught means the assertion it names cannot fail for that reason.");
  console.log("That is a test reporting success regardless of the code, which is the whole point of this sweep.");
  for (const p of s.problems) console.log(`  · ${p.name}: ${p.verdict}`);
}
process.exit(s.ok ? 0 : 1);
