// The durable phase artifact: written atomically, hashed from the bytes on
// disk, and read back before anything is allowed to depend on it.
//
// A transition commits only after its artifact is durable. That makes two things
// load-bearing, and they fail differently: the write must be atomic against a
// crash, so a process that dies mid-write leaves NO artifact rather than a short
// one; and the sha recorded must be the sha of the bytes that survived, not of
// the buffer that was intended.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, lstatSync,
         readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { ARTIFACT_FILE } from "../src/paths.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { applyTransition } from "../src/build/transition.mjs";
import { isSameProcess, readStart } from "../src/supervisor.mjs";
import { fileTask } from "../src/build/taskfile.mjs";
import { writeArtifact, readArtifact, reviewArtifact } from "../src/build/artifact.mjs";
import { reviewDiff } from "../src/sandbox.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-artifact-"));
const HERE = dirname(fileURLToPath(import.meta.url));

// A REAL FILED TASK, so the transition assertions run against a real row rather
// than a hand-built one. A hand-built task cannot exhibit the compare-and-set.
const repo = join(dir, "repo");
mkdirSync(join(repo, "packages", "x"), { recursive: true });
writeFileSync(join(repo, "p.json"), "{}\n");
const registry = { version: 1, projects: {
  nextly: { nwo: "nextlyhq/nextly", repoPath: repo, profilePath: join(repo, "p.json") } } };
const io = { lstat: (p) => lstatSync(p), lsTree: () => null,
  repoId: async () => 42, profileHash: async () => "ph-1", defaultBranch: async () => "main",
  visibility: async () => "private", specRepoId: async () => 77,
  gateDefinitionHash: async () => "gd-1", founderUserId: async () => 9 };
const db = openHub(join(dir, "hub.db"));
const filed = await fileTask({ db, registry, project: "nextly", title: "a scout task",
  territory: ["packages/x"], io, isAlive: isSameProcess,
  pid: process.pid, lstart: readStart(process.pid) });
check(filed.ok === true, "fixture: a task is filed", JSON.stringify(filed));
const toSizing = applyTransition(db, { taskId: filed.task, expectedPhase: "FILED",
  expectedGeneration: 1, evidence: { kind: "phase.succeeded", phase: "FILED" },
  op: "phase.advanced", isAlive: isSameProcess });
check(toSizing.applied === true, "fixture: and advanced to SIZING", JSON.stringify(toSizing));

// ── The interrupted write ───────────────────────────────────────────────────
//
// A child writes a large artifact through the REAL function; the parent kills
// its process GROUP the moment a temporary entry appears.
//
// What this can exhibit: a process that died between the write and the rename.
// What it CANNOT: a power loss, or a rename a filesystem reordered against the
// fsync. Those are the platform's guarantee, not this function's, and the code
// asks for them rather than proving them.
//
// If the child finishes before the parent sees the temporary file, the drill
// never reached its window. That is reported RED, never skipped, because an
// unreached window and a passing guard look identical in the log.
{
  const adir = join(dir, "interrupted");
  const worker = join(dir, "slow-write.mjs");
  writeFileSync(worker,
    `import { writeArtifact } from ${JSON.stringify(pathToFileURL(join(HERE, "..", "src", "build", "artifact.mjs")).href)};\n` +
    `writeArtifact({ dir: process.argv[2], phase: "RESEARCH",\n` +
    `                bytes: Buffer.alloc(256 * 1024 * 1024, 0x61) });\n` +
    `console.log("finished");\n`);
  const child = spawn(process.execPath, [worker, adir], { detached: true, stdio: "ignore" });
  // THE EXIT LISTENER IS ATTACHED NOW, before anything can be awaited. Attaching
  // it after the child has already exited never fires -- the event is gone -- so
  // the await below would HANG rather than fail, and a hung test truncates the
  // run instead of reporting it. That is strictly worse than a red assertion:
  // the assertions after it never run and cannot be told from ones that passed.
  const exited = new Promise(r => child.once("exit", r));
  let sawTmp = false;
  for (let i = 0; i < 4000 && !sawTmp; i++) {
    try { sawTmp = readdirSync(adir).some(f => f.includes(".tmp-")); } catch { /* not created yet */ }
    if (!sawTmp) await new Promise(r => setTimeout(r, 1));
  }
  check(sawTmp, "control: the drill reached the window between write and rename");
  try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
  // AND RACED AGAINST A DEADLINE, so a child that cannot be reaped for any
  // reason still cannot stop this file from reporting what it found.
  await Promise.race([exited, new Promise(r => setTimeout(r, 10000))]);

  const left = (() => { try { return readdirSync(adir); } catch { return []; } })();
  check(!existsSync(join(adir, "research.md")),
    "no artifact exists after a write interrupted before its rename", left.join(","));
  check(left.length > 0 && left.every(f => f.includes(".tmp-")),
    "and the artifacts directory holds only the temporary file", left.join(","));
  const r = readArtifact({ dir: adir, phase: "RESEARCH", expectSha: "0".repeat(64) });
  check(r.ok === false, "reading it back refuses rather than returning empty content", JSON.stringify(r));

  // AND THE TRANSITION REFUSES, which is the property that matters: an artifact
  // that is not durable must not be able to justify a phase advance.
  const t = applyTransition(db, { taskId: filed.task, expectedPhase: "SIZING",
    expectedGeneration: 1, evidence: { kind: "phase.succeeded", phase: "SIZING", depth: "standard" },
    artifactSha: null, op: "phase.advanced", isAlive: isSameProcess });
  check(t.applied === false && t.reason === "refused",
    "and the transition it would have justified is refused", JSON.stringify(t));
  check(/no artifact sha/.test(String(t.refusal)),
    "naming the missing sha as the reason", String(t.refusal));
  const ev = db.prepare(
    "SELECT payload FROM hub_event WHERE task=? AND kind='transition.refused' ORDER BY seq DESC LIMIT 1")
    .get(filed.task);
  check(ev !== undefined && /no artifact sha/.test(ev.payload),
    "and the refusal is durable, not merely returned", JSON.stringify(ev));
}

// ── The read-back ───────────────────────────────────────────────────────────
//
// The sha recorded is the sha of the bytes ON DISK, checked by mutating the file
// underneath a known-good sha.
{
  const adir = join(dir, "readback");
  const w = writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from("# design\n\n## Slice 1\n") });
  check(typeof w.sha256 === "string" && w.sha256.length === 64, "a write returns a sha256", w.sha256);
  check(existsSync(w.path) && readdirSync(adir).length === 1,
    "and leaves exactly one file, with no temporary beside it", readdirSync(adir).join(","));
  const good = readArtifact({ dir: adir, phase: "DESIGN", expectSha: w.sha256 });
  check(good.ok === true, "control: reading it back with the recorded sha succeeds", JSON.stringify(good));
  check(good.sha256 === w.sha256, "and re-derives the same sha from the bytes on disk", good.sha256);

  writeFileSync(w.path, "# design\n\n## Slice 1\ntampered\n");
  const bad = readArtifact({ dir: adir, phase: "DESIGN", expectSha: w.sha256 });
  check(bad.ok === false, "and a file mutated after the write is refused on read-back", JSON.stringify(bad));
  check(/sha/.test(String(bad.why)), "with the sha mismatch as the reason", String(bad.why));
}

// ── The sha describes the FILE, not the buffer ─────────────────────────────
//
// The whole point of hashing is defeated if a short write is reported with the
// sha of the bytes that were intended. Asserted by writing a large artifact and
// requiring the file on disk to be exactly the length claimed AND to re-derive
// the sha claimed -- the two together are what a later reader relies on.
{
  const adir = join(dir, "wholewrite");
  const bytes = Buffer.alloc(8 * 1024 * 1024, 0x62);
  const w = writeArtifact({ dir: adir, phase: "RESEARCH", bytes });
  check(w.bytes === bytes.length, "a write reports the length it was given", `${w.bytes} vs ${bytes.length}`);
  check(lstatSync(w.path).size === bytes.length,
    "and the file on disk is exactly that long", `${lstatSync(w.path).size} vs ${bytes.length}`);
  const back = readArtifact({ dir: adir, phase: "RESEARCH", expectSha: w.sha256 });
  check(back.ok === true,
    "and the recorded sha re-derives from the file, so it describes what survived", JSON.stringify(back.why));
}

// ── A phase with no artifact has no store ──────────────────────────────────
{
  for (const fn of [() => writeArtifact({ dir, phase: "IMPLEMENTING", bytes: Buffer.from("x") }),
                    () => readArtifact({ dir, phase: "IMPLEMENTING", expectSha: "0".repeat(64) })]) {
    let threw = null;
    try { fn(); } catch (e) { threw = String(e.message); }
    check(threw !== null && /produces no artifact/.test(threw),
      "a phase whose product is a diff is refused by both halves of the store", String(threw));
  }
  // AND A READ WITH NOTHING TO COMPARE IS NOT A CHECK.
  let t = null;
  try { readArtifact({ dir, phase: "DESIGN" }); } catch (e) { t = String(e.message); }
  check(t !== null && /needs the sha it expects/.test(t),
    "and a read-back with no expected sha throws rather than certifying nothing", String(t));
}

// ── The minimum, and the control ───────────────────────────────────────────
//
// A checker that refuses everything proves nothing about the thing it refuses,
// so the passing case is asserted FIRST and the failing case differs from it by
// exactly the citation.
{
  const adir = join(dir, "review");
  const cited = "# research\n\n- openHub refuses a hub above the schema version " +
                "(src/build/hubaccess.mjs:170)\n- the guest handle revalidates dev:ino " +
                "(src/build/hubaccess.mjs:42)\n";
  writeArtifact({ dir: adir, phase: "RESEARCH", bytes: Buffer.from(cited) });
  const good = reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  check(good.ok === true,
    "control: a research artifact whose every claim carries a file:line citation passes",
    JSON.stringify(good));

  writeArtifact({ dir: adir, phase: "RESEARCH",
    bytes: Buffer.from(cited.replace(" (src/build/hubaccess.mjs:170)", "")) });
  const bad = reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  check(bad.ok === false, "a claim with no file:line citation is refused", JSON.stringify(bad));
  check(bad.findings.length === 1,
    "and exactly the one uncited claim is named, not the whole file", JSON.stringify(bad.findings));

  // AND THE SURVIVING CLAIM IS STILL CITED, which is what makes the count above
  // meaningful: a whole-file check would pass on this artifact, because the
  // OTHER claim carries a citation.
  check(/hubaccess\.mjs:42/.test(cited.replace(" (src/build/hubaccess.mjs:170)", "")),
    "control: the artifact still contains a cited claim, so a whole-file check would pass it");
}

// ── The two gates, asserted in BOTH directions ─────────────────────────────
//
// Each is mandatory for its own dispatch path, so each must refuse the other's.
// The dangerous direction is an artifact phase silently reaching the diff gate:
// it arrives with an empty file list and is refused as "the worker produced an
// empty diff" -- a refusal that reads as the worker's fault and is the gate's.
{
  let a = null, b = null;
  try { reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action: "RESEARCH" }); }
  catch (e) { a = String(e.message); }
  check(a !== null, "reviewDiff throws when handed an artifact phase", String(a));
  check(/reviewArtifact/.test(String(a)), "and names the sibling that owns that path", String(a));

  try { reviewArtifact({ phase: "IMPLEMENTING", dir: join(dir, "review"), expect: { depth: "standard" } }); }
  catch (e) { b = String(e.message); }
  check(b !== null, "and reviewArtifact throws when handed a diff phase", String(b));
  check(/reviewDiff/.test(String(b)), "and names its sibling too", String(b));

  // EVERY artifact phase, not the one that happened to be tested. The guard is
  // derived from the phase map, so this asserts the derivation rather than one
  // branch of it -- a fourth report phase added later is covered without anyone
  // remembering to come back here.
  for (const phase of Object.keys(ARTIFACT_FILE)) {
    let t = null;
    try { reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action: phase }); }
    catch (e) { t = String(e.message); }
    check(t !== null, `reviewDiff refuses ${phase} too, because the guard is derived`, String(t));
  }

  // CONTROL: the guardian's own actions still go through unchanged. This asserts
  // that reviewDiff RETURNS rather than that it returns ok -- what the new guard
  // must not do is throw, and its verdict on an ordinary diff is existing
  // shipped behaviour that is not this change's to alter.
  let threw = false, ordinary = null;
  try { ordinary = reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action: "FIX_CI" }); }
  catch { threw = true; }
  check(threw === false && ordinary !== null,
    "control: reviewDiff still returns for an ordinary guardian action", JSON.stringify(ordinary));

  // AND FOR action: null, which is what every existing caller that does not
  // classify passes. A guard that threw on null would take the guardian down.
  let nullThrew = false;
  try { reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action: null }); }
  catch { nullThrew = true; }
  check(nullThrew === false, "control: and for action null, which existing callers pass");
}

// ── No optional parameter ──────────────────────────────────────────────────
//
// The optional `gate` parameter lost to the sibling function precisely because
// an optional safety parameter is omitted by the caller that most needs it.
{
  check(reviewArtifact.length === 1,
    "reviewArtifact takes exactly one required argument", String(reviewArtifact.length));
  let missing = null;
  try { reviewArtifact({ phase: "RESEARCH", dir: join(dir, "review") }); }
  catch (e) { missing = String(e.message); }
  check(missing !== null && /expect/.test(missing),
    "and refuses a call that omits `expect` rather than defaulting it", String(missing));
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
