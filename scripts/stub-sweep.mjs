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
import { readFileSync, writeFileSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdit, validateManifest, classify, summarise, CAUGHT, UNRUNNABLE, TIMED_OUT_EXIT } from "../src/stubsweep.mjs";

// Overridable so the runner can be pointed at a throwaway repository built by its
// own test. The cleanliness guard then applies to THAT tree, so the real one is
// not weakened to make itself testable -- which would be the usual way a guard
// becomes decorative.
const ROOT = process.env.STUB_SWEEP_ROOT
  ? resolve(process.env.STUB_SWEEP_ROOT)
  : resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha = p => createHash("sha256").update(readFileSync(p)).digest("hex");

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
  die(2, "stub-sweep: the working tree has uncommitted changes.\n" +
         "This sweep restores files between entries and cannot tell your work from a stub.\n" +
         "Commit or stash first. Refusing rather than risking it:\n" + dirty);

// A SEAM, so the runner can be driven against a manifest built for a test.
// Without it the only way to check that this tool FAILS on an uncaught stub would
// be to break the repository on purpose and look — which is to say, no way at all.
// An instrument that cannot be shown to fail is the exact shape it exists to find.
const manifestPath = process.env.STUB_MANIFEST
  ? resolve(process.env.STUB_MANIFEST)
  : join(ROOT, "test", "stub-manifest.mjs");
let manifest;
try {
  manifest = validateManifest((await import(manifestPath)).STUBS);
} catch (err) {
  die(2, `stub-sweep: the manifest is not usable: ${err.message}`);
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
const runTest = file => new Promise(resolve => {
  const child = spawn(process.execPath, [join(ROOT, file)], { cwd: ROOT });
  let out = "";
  child.stdout.on("data", d => { out += d; });
  child.stderr.on("data", d => { out += d; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 600_000);
  let timedOut = false;
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    // A killed child is reported as its own thing rather than coerced, because
    // "timed out" and "failed an assertion" are different readings and only one of
    // them is evidence.
    resolve({ exit: timedOut || code === null ? TIMED_OUT_EXIT : code, output: out });
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
  for (const [f, snap] of active.snaps) {
    try { copyFileSync(snap.copy, f); } catch (err) { failed.push([f, snap.copy, err.message]); }
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

const results = [];
for (const entry of entries) {
  const files = [...new Set(entry.edits.map(e => join(ROOT, e.file)))];
  const control = await runTest(entry.test);

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
  active = { snaps, dir: snapDir };

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
    for (const f of files) stubbedHashes.set(f, sha(f));
  } catch (err) {
    applyError = err;
  }

  const stub = applyError ? { exit: 0, output: "" } : await runTest(entry.test);

  // THE FILE MUST STILL BE THE STUB WE WROTE.
  //
  // The cleanliness check at start-up cannot protect work created AFTER the
  // snapshot, and a stubbed test can hold the tree for up to ten minutes. If an
  // editor saved over one of these files in that window, copying the snapshot back
  // silently destroys real work — the same class of loss as `git checkout`
  // restoring to the last commit, which is what this whole mechanism replaced.
  const meddled = files.filter(f => sha(f) !== stubbedHashes.get(f));
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

  const verdict = applyError
    ? { verdict: "UNRUNNABLE", why: `the stub could not be applied: ${applyError.message}` }
    : classify({ controlExit: control.exit, stubExit: stub.exit, stubOutput: stub.output,
                 hashChanged, restored, expectRed: entry.expectRed });

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
if (!s.ok) {
  console.log("\nA stub that is not caught means the assertion it names cannot fail for that reason.");
  console.log("That is a test reporting success regardless of the code, which is the whole point of this sweep.");
  for (const p of s.problems) console.log(`  · ${p.name}: ${p.verdict}`);
}
process.exit(s.ok ? 0 : 1);
