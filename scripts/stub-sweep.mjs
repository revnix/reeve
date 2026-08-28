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
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyEdit, validateManifest, classify, summarise, CAUGHT } from "../src/stubsweep.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
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

const manifestPath = join(ROOT, "test", "stub-manifest.mjs");
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

const runTest = file => {
  const r = spawnSync(process.execPath, [join(ROOT, file)], { cwd: ROOT, encoding: "utf8", timeout: 600_000 });
  // A killed child has a null status. Reported as its own thing rather than
  // coerced to a number, because "timed out" and "failed" are different readings.
  return { exit: r.status === null ? 124 : r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const results = [];
for (const entry of entries) {
  const files = [...new Set(entry.edits.map(e => join(ROOT, e.file)))];
  const control = runTest(entry.test);

  // Snapshot BEFORE touching anything, and restore from these copies. A run killed
  // partway then cannot leave a stub behind for the next reading to measure.
  const snapDir = mkdtempSync(join(tmpdir(), "stub-sweep-"));
  const snaps = new Map();
  for (const f of files) {
    const to = join(snapDir, createHash("sha256").update(f).digest("hex"));
    copyFileSync(f, to);
    snaps.set(f, { copy: to, hash: sha(f) });
  }

  let applyError = null;
  let hashChanged = false;
  try {
    for (const f of files) {
      const edits = entry.edits.filter(e => join(ROOT, e.file) === f);
      let src = readFileSync(f, "utf8");
      for (const ed of edits) src = applyEdit(src, ed);
      writeFileSync(f, src);
    }
    // Proof the stub landed, independent of the anchors that placed it.
    hashChanged = files.some(f => sha(f) !== snaps.get(f).hash);
  } catch (err) {
    applyError = err;
  }

  const stub = applyError ? { exit: 0, output: "" } : runTest(entry.test);

  for (const [f, s] of snaps) copyFileSync(s.copy, f);
  const restored = files.every(f => sha(f) === snaps.get(f).hash);
  rmSync(snapDir, { recursive: true, force: true });

  const verdict = applyError
    ? { verdict: "UNRUNNABLE", why: `the stub could not be applied: ${applyError.message}` }
    : classify({ controlExit: control.exit, stubExit: stub.exit, stubOutput: stub.output,
                 hashChanged, restored, expectRed: entry.expectRed });

  results.push({ name: entry.name, why: entry.why, ...verdict });
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
