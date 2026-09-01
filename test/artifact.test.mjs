// The durable phase artifact: written atomically, hashed from the bytes on
// disk, and read back before anything is allowed to depend on it.
//
// A transition commits only after its artifact is durable. That makes two things
// load-bearing, and they fail differently: the write must be atomic against a
// crash, so a process that dies mid-write leaves NO artifact rather than a short
// one; and the sha recorded must be the sha of the bytes that survived, not of
// the buffer that was intended.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, lstatSync,
         readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { ARTIFACT_FILE } from "../src/paths.mjs";
import { BUILD_ACTION_FOR, BUILD_ACTIONS } from "../src/build/phases.mjs";
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

  // THE NAMES CALLERS ACTUALLY PASS, which is the assertion that was missing.
  // `reviewDiff` receives `decision.action`, and a report phase is dispatched
  // under a BUILD_ name. Asserting only the PHASE names tested the guard against
  // a vocabulary no caller uses: correct-looking, green, and unreachable.
  //
  // Both vocabularies are looped, and both come from the module that declares
  // them, so a fourth report phase is covered without anyone returning here.
  for (const action of BUILD_ACTIONS) {
    let t = null;
    try { reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action }); }
    catch (e) { t = String(e.message); }
    check(t !== null, `reviewDiff refuses the dispatch name ${action}`, String(t));
  }
  for (const phase of Object.keys(ARTIFACT_FILE)) {
    let t = null;
    try { reviewDiff({ files: ["packages/x/a.ts"], profile: {}, lane: null, action: phase }); }
    catch (e) { t = String(e.message); }
    check(t !== null, `reviewDiff refuses the phase name ${phase} too`, String(t));
  }
  // AND THE TWO VOCABULARIES REALLY DIFFER, so the loops above are not one loop
  // written twice. phases.mjs records that SIZING dispatches as BUILD_SIZE, not
  // BUILD_SIZING, which is why neither list can be derived from the other.
  check(BUILD_ACTION_FOR.SIZING === "BUILD_SIZE",
    "control: the dispatch name is not the phase name with a prefix", BUILD_ACTION_FOR.SIZING);
  check(BUILD_ACTIONS.every(a => !Object.hasOwn(ARTIFACT_FILE, a)),
    "control: and no dispatch name is a phase name, so covering one is not covering both",
    BUILD_ACTIONS.join(","));

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

// ── The gate reports the digest of what IT read ────────────────────────────
//
// An artifact replaced between the write and the gate -- by a recovered attempt,
// or a concurrent one -- was validated here and then recorded under the earlier
// write's sha, so the transition bound to bytes this gate never saw.
{
  const adir = join(dir, "gatesha");
  const first = writeArtifact({ dir: adir, phase: "RESEARCH",
    bytes: Buffer.from("# research\n\n- a claim (src/x.mjs:1)\n") });
  const replaced = writeArtifact({ dir: adir, phase: "RESEARCH",
    bytes: Buffer.from("# research\n\n- a different claim (src/y.mjs:2)\n") });
  check(first.sha256 !== replaced.sha256, "control: the replacement really has a different sha");

  const gate = reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  check(gate.ok === true, "control: the replacement passes the gate", JSON.stringify(gate.findings));
  check(gate.sha256 === replaced.sha256,
    "the gate reports the sha of the bytes it reviewed, not the earlier write's",
    `${gate.sha256} vs replaced ${replaced.sha256} / first ${first.sha256}`);

  // AND ON THE REFUSAL PATH TOO, because a refusal that cannot say which bytes
  // it refused cannot be acted on.
  writeArtifact({ dir: adir, phase: "RESEARCH", bytes: Buffer.from("# research\n\n- uncited\n") });
  const bad = reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  check(bad.ok === false && typeof bad.sha256 === "string" && bad.sha256.length === 64,
    "and a refusal names the sha it refused", JSON.stringify({ ok: bad.ok, sha: bad.sha256 }));
}

// ── A failed write leaves no temporary behind ──────────────────────────────
//
// A full disk is the ordinary case. The partial file used to survive, and every
// retry minted another randomly named one -- so the failures consumed the space
// needed to recover, turning a transient full disk into a permanent one.
{
  const adir = join(dir, "failedwrite");
  let threw = null;
  // A Proxy that reports a huge length makes writeSync throw on a real buffer,
  // which is the shape of a write that fails partway rather than a fabricated
  // error thrown before any file was created.
  try {
    writeArtifact({ dir: adir, phase: "DESIGN",
      bytes: new Proxy(Buffer.from("x"), { get: (t, k) => k === "length" ? 1e9 : Reflect.get(t, k) }) });
  } catch (e) { threw = String(e.message); }
  check(threw !== null, "control: the write really failed", String(threw));
  const left = (() => { try { return readdirSync(adir); } catch { return []; } })();
  check(!left.some(f => f.includes(".tmp-")),
    "a failed write leaves no temporary file behind", left.join(",") || "(directory empty)");
}

// ── Absence must not satisfy a rule about presence ─────────────────────────
//
// With no claims the citation loop runs zero times, so every claim is trivially
// cited and an artifact that is all headings and prose passed a gate whose whole
// subject is the claims it does not contain. "Nothing to check" is not "checked",
// and it is the shape this repository keeps finding.
{
  const adir = join(dir, "minima");
  const gate = (body, phase = "RESEARCH") => {
    writeArtifact({ dir: adir, phase, bytes: Buffer.from(body) });
    return reviewArtifact({ phase, dir: adir, expect: { depth: "standard" } });
  };
  const empty = gate("# research\n\nprose, and no list items at all.\n");
  check(empty.ok === false, "a research artifact with NO claims is refused", JSON.stringify(empty.findings));
  // Asserted on the part that carries the MEANING rather than the opening
  // words: the message gained a count when minClaims became the caller's, and a
  // test pinned to its first phrase breaks on a rewording that changes nothing.
  check(/nothing to cite/.test(empty.findings.join(" ")),
    "and says the rule was satisfied only because there was nothing to cite", empty.findings.join(" "));

  // CONTROL: one cited claim still passes, so the refusal is about absence
  // rather than about the gate having become stricter everywhere.
  const one = gate("# research\n\n- a claim (src/x.mjs:12)\n");
  check(one.ok === true, "control: a single cited claim still passes", JSON.stringify(one.findings));
}

// ── A URL's port is not a file citation ────────────────────────────────────
//
// Research is full of links, and `[\w./-]+:\d+` matches localhost:3000 exactly as
// it matches src/x.mjs:170 -- so the gate accepted precisely the unsupported
// claims it exists to reject.
{
  const adir = join(dir, "urls");
  const gate = (body) => {
    writeArtifact({ dir: adir, phase: "RESEARCH", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  };
  for (const url of ["http://localhost:3000", "https://example.com:8080", "ftp://host:21/x"]) {
    const r = gate(`# research\n\n- an unsupported claim ${url}\n`);
    check(r.ok === false, `a claim supported only by ${url} is refused`, JSON.stringify(r.findings));
  }
  // CONTROLS, and they are what stop this becoming "URLs are banned": a claim
  // that carries BOTH a link and a real citation passes, and a bare citation
  // still passes.
  const both = gate("# research\n\n- a claim (src/x.mjs:12), see http://localhost:3000\n");
  check(both.ok === true, "control: a claim with a citation AND a URL passes", JSON.stringify(both.findings));
  const bare = gate("# research\n\n- a claim (src/build/hubaccess.mjs:170)\n");
  check(bare.ok === true, "control: and a bare file:line citation still passes", JSON.stringify(bare.findings));
}

// ── Valid JSON is not a sizing ─────────────────────────────────────────────
{
  const adir = join(dir, "sizing");
  const gate = (body) => {
    writeArtifact({ dir: adir, phase: "SIZING", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "SIZING", dir: adir, expect: { depth: "standard" } });
  };
  for (const [label, body] of [["null", "null"], ["an array", "[]"], ["a scalar", "7"],
                               ["an empty object", "{}"]]) {
    const r = gate(body);
    check(r.ok === false, `sizing.json that is ${label} is refused`, JSON.stringify(r.findings));
  }
  check(gate("{ not json").ok === false, "and one that does not parse is still refused");
  // CONTROL: an object carrying the whole documented contract passes. This
  // assertion previously required only a depth, which encoded a position I got
  // wrong -- I argued that requiring the other fields would be guessing at what
  // the sizing phase emits, when the design states the shape. The DEPTH VALUE is
  // still not re-checked here: the transition owns that vocabulary and refuses
  // an unknown depth durably, so a copy of the list would be a second inventory.
  const good = gate(JSON.stringify({ depth: "standard", est_files: 3, est_weighted_files: 4,
    est_packages: 1, est_slices: 2, risk_paths_touched: [], rationale: "x" }));
  check(good.ok === true, "control: an object carrying the full contract passes", JSON.stringify(good.findings));
}

// ── The counts are INTEGERS, because the schema says they are ──────────────
//
// `build_size.json` declares est_files, est_weighted_files, est_packages and
// est_slices as `{"type": "integer", "minimum": 0}`. Three of the four were
// checked here with `Number.isFinite`, so `est_files: 0.5` was durably approved
// by this gate and refused by the schema -- one artifact, two verdicts, and the
// gate is the one that says the work may proceed.
//
// EVERY COUNT IS EXERCISED, not the one that was reported. The defect was a
// predicate written out four times and corrected in one of them, so a test
// naming only est_files would pass against a fix applied only to est_files.
{
  const adir = join(dir, "sizing-counts");
  const FULL = { depth: "standard", est_files: 3, est_weighted_files: 4, est_packages: 1,
                 est_slices: 2, risk_paths_touched: ["packages/x"], rationale: "x" };
  const gate = (over) => {
    writeArtifact({ dir: adir, phase: "SIZING", bytes: Buffer.from(JSON.stringify({ ...FULL, ...over })) });
    return reviewArtifact({ phase: "SIZING", dir: adir, expect: { depth: "standard" } });
  };
  // THE CONTROL FIRST, so every refusal below is caused by the field it changes
  // rather than by the fixture being wrong in some way none of them names.
  const base = gate({});
  check(base.ok === true, "control: the sizing fixture passes untouched", JSON.stringify(base.findings));
  for (const field of ["est_files", "est_weighted_files", "est_packages", "est_slices"]) {
    const r = gate({ [field]: 0.5 });
    check(r.ok === false, `a fractional ${field} is refused`, JSON.stringify(r.findings));
    check(r.findings.some(f => f.includes(field)),
      `and the finding names ${field}, so an operator is told which count is wrong`,
      JSON.stringify(r.findings));
  }
  // AND THE ITEMS OF THE LIST, not only the container. `Array.isArray` alone
  // admitted both of these, and the sizing floor intersects this list against
  // the profile's risk paths: a non-string matches nothing, so an artifact
  // naming its risk paths as numbers reads as touching none, and the floor that
  // exists for exactly that case does not fire.
  const numeric = gate({ risk_paths_touched: [3] });
  check(numeric.ok === false, "a risk path that is not a string is refused", JSON.stringify(numeric.findings));
  const blank = gate({ risk_paths_touched: ["  "] });
  check(blank.ok === false, "and so is a blank one, which matches no path either", JSON.stringify(blank.findings));
  // AND THE EMPTY LIST STILL PASSES. Touching no risk path is an answer, and a
  // check that refused it would refuse most of the sizings this gate exists for.
  const empty = gate({ risk_paths_touched: [] });
  check(empty.ok === true, "control: an empty risk-path list still passes", JSON.stringify(empty.findings));
}

// ── Every slice, not the document ──────────────────────────────────────────
//
// The same per-unit distinction the citation check makes, which was missing
// here: a whole-document `includes` passes as soon as ONE slice carries each
// label, so a complete first slice made an empty second slice invisible.
{
  const adir = join(dir, "slices");
  const gate = (body) => {
    writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "DESIGN", dir: adir, expect: { depth: "standard" } });
  };
  const complete = "## Slice 1\nFiles: a\nPackages: b\nTests: c\nDone when: d\n";
  const bad = gate(`# design\n\n${complete}\n## Slice 2\n`);
  check(bad.ok === false, "a second slice missing everything is refused", JSON.stringify(bad.findings));
  check(bad.findings.some(f => /Slice 2/.test(f)),
    "and the finding names WHICH slice, not the document", JSON.stringify(bad.findings));
  check(!bad.findings.some(f => /Slice 1/.test(f)),
    "and does not blame the slice that was complete", JSON.stringify(bad.findings));

  const good = gate(`# design\n\n${complete}\n## Slice 2\nFiles: e\nPackages: f\nTests: g\nDone when: h\n`);
  check(good.ok === true, "control: two complete slices pass", JSON.stringify(good.findings));
}

// ── A deep tree is created and readable ────────────────────────────────────
//
// `mkdirSync` with `recursive` can create a whole chain, and each new directory
// is an entry in ITS parent. What is assertable here is that the write succeeds
// and reads back through every new level; that the fsyncs make the chain survive
// a power loss is the platform's guarantee, which this code asks for and does
// not prove -- stated rather than implied, as with the interrupted-write drill.
{
  const deep = join(dir, "a", "b", "c", "d", "artifacts");
  const w = writeArtifact({ dir: deep, phase: "DESIGN", bytes: Buffer.from("# design\n\n## Slice 1\nFiles: a\nPackages: b\nTests: c\nDone when: d\n") });
  check(existsSync(w.path), "an artifact written into a chain of new directories exists", w.path);
  const back = readArtifact({ dir: deep, phase: "DESIGN", expectSha: w.sha256 });
  check(back.ok === true, "and reads back with the sha it was written under", JSON.stringify(back.why));
}

// ── A failed RENAME takes its temporary too ────────────────────────────────
//
// The cleanup covered the write and not the rename, three lines further down in
// the same function: one site fixed and its sibling left. A rename that fails
// after a successful write leaves a COMPLETE temporary, and every retry leaves
// another -- worse than the partial-write case it was fixed alongside, because
// each one is full size.
{
  const adir = join(dir, "renamefail");
  // The destination is made a DIRECTORY, so the rename fails after the bytes are
  // safely written -- which is the ordering this assertion is about.
  mkdirSync(join(adir, "design.md"), { recursive: true });
  let threw = null;
  try { writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from("# design\n") }); }
  catch (e) { threw = e.code ?? String(e.message); }
  check(threw !== null, "control: the rename really failed", String(threw));
  const left = readdirSync(adir).filter(f => f.includes(".tmp-"));
  check(left.length === 0, "a failed rename leaves no temporary behind", left.join(","));
}

// ── Temporaries from killed writers are reaped, live ones are not ──────────
//
// The rename is what publishes a file, so a temporary is referenced by nothing
// and nothing was ever going to remove it. A worker killed between the open and
// the rename therefore leaves a full-size file for ever, and repeated crashes
// fill the disk for a reason nobody can find.
//
// AGE, not process identity: pids are reused, so a live writer's temporary can
// carry a pid this process believes is dead.
{
  const adir = join(dir, "reap");
  const design = "# design\n\n## Slice 1\nFiles: a\nPackages: b\nTests: c\nDone when: d\n";
  writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from(design) });

  const stale = join(adir, "design.md.tmp-99999-stale");
  const live  = join(adir, "design.md.tmp-99998-live");
  writeFileSync(stale, "left by a killed writer");
  writeFileSync(live, "another writer, in flight right now");
  const twoHoursAgo = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
  utimesSync(stale, twoHoursAgo, twoHoursAgo);

  writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from(design) });
  const left = readdirSync(adir).filter(f => f.includes(".tmp-"));
  check(!left.includes("design.md.tmp-99999-stale"),
    "a temporary older than the threshold is reaped by the next write", left.join(","));
  // THE CONTROL THAT MATTERS. A reaper that removed every temporary would delete
  // a concurrent writer's file mid-write, which is far worse than the leak it
  // fixes -- so the recent one must survive.
  check(left.includes("design.md.tmp-99998-live"),
    "and a RECENT one is left alone, because it may be a live writer's", left.join(","));

  // And the artifact itself is unharmed by the reaping.
  const back = readArtifact({ dir: adir, phase: "DESIGN",
    expectSha: writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from(design) }).sha256 });
  check(back.ok === true, "control: and the artifact still reads back", JSON.stringify(back.why));
}

// ── A slice ends at the next SECTION, not the next slice ───────────────────
{
  const adir = join(dir, "trailing");
  const gate = (body) => {
    writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "DESIGN", dir: adir, expect: { depth: "standard" } });
  };
  const one = "## Slice 1\nFiles: a\nPackages: b\nTests: c\nDone when: d\n";
  const bad = gate(`# design\n\n${one}\n## Slice 2\n\n## Notes\nFiles: x\nPackages: y\nTests: z\nDone when: w\n`);
  check(bad.ok === false,
    "an empty final slice does not inherit a trailing section's labels", JSON.stringify(bad.findings));
  check(bad.findings.some(f => /Slice 2/.test(f)),
    "and the finding names the empty slice", JSON.stringify(bad.findings));

  // CONTROL: a trailing section after a COMPLETE final slice is still fine, so
  // the bound did not make an ordinary document fail.
  const good = gate(`# design\n\n${one}\n## Slice 2\nFiles: e\nPackages: f\nTests: g\nDone when: h\n\n## Notes\nprose\n`);
  check(good.ok === true, "control: a trailing section after a complete slice is fine",
    JSON.stringify(good.findings));
}

// ── A citation is a PATH and a line, not any token with a colon ────────────
//
// `[\w./-]+:\d+` matched `12:30` and `issue:42` as readily as
// `src/build/hubaccess.mjs:170`, so a claim mentioning a time or a ticket read
// as sourced. The URL fix closed one leak in that pattern and left the rest --
// the same shape, one round later.
{
  const adir = join(dir, "citeshape");
  const g = (body) => {
    writeArtifact({ dir: adir, phase: "RESEARCH", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  };
  for (const token of ["12:30", "issue:42", "PR:103", "10:00"])
    check(g(`# r\n\n- a claim, observed at ${token}\n`).ok === false,
      `${token} is not a file citation`);
  // CONTROLS: what a citation actually looks like must still pass, in both the
  // pathed and the bare-filename form.
  check(g("# r\n\n- a claim (src/build/hubaccess.mjs:170)\n").ok === true,
    "control: a path with a line number still passes");
  check(g("# r\n\n- a claim (hubaccess.mjs:170)\n").ok === true,
    "control: and a bare filename with a line number");
}

// ── A label is not an answer ───────────────────────────────────────────────
{
  const adir = join(dir, "labelvalues");
  const g = (body) => {
    writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "DESIGN", dir: adir, expect: { depth: "standard" } });
  };
  const bare = g("# d\n\n## Slice 1\nFiles:\nPackages:\nTests:\nDone when:\n");
  check(bare.ok === false, "a slice carrying the bare scaffold is refused", JSON.stringify(bare.findings));
  check(bare.findings.some(f => /nothing after it/.test(f)),
    "and says the label was there and the value was not", JSON.stringify(bare.findings));
  check(g("# d\n\n## Slice 1\nFiles: a\nPackages: b\nTests: c\nDone when: d\n").ok === true,
    "control: the same slice with values passes");
}

// ── The sizing contract, as the design writes it ───────────────────────────
//
// I declined this once, arguing that requiring fields would encode what the
// sizing phase is merely EXPECTED to emit. That was wrong: the design states the
// shape, so these are the artifact's terms rather than a guess about a task
// nobody has written. The depth VALUE is still not re-checked here -- the
// transition owns that vocabulary and refuses an unknown depth durably.
{
  const adir = join(dir, "sizingcontract");
  const g = (o) => {
    writeArtifact({ dir: adir, phase: "SIZING", bytes: Buffer.from(JSON.stringify(o)) });
    return reviewArtifact({ phase: "SIZING", dir: adir, expect: { depth: "standard" } });
  };
  const full = { depth: "standard", est_files: 3, est_weighted_files: 4, est_packages: 1,
                 est_slices: 2, risk_paths_touched: [], rationale: "because" };
  check(g(full).ok === true, "control: the full contract passes", JSON.stringify(g(full).findings));
  check(g({ depth: "standard" }).ok === false, "a sizing carrying only a depth is refused");
  // EVERY field, not the one that happened to be tested.
  for (const field of Object.keys(full)) {
    const missing = { ...full }; delete missing[field];
    const r = g(missing);
    check(r.ok === false && r.findings.some(f => f.includes(field)),
      `a sizing omitting ${field} is refused, and the finding names it`, JSON.stringify(r.findings));
  }
  // AND IT IS REPORTED AS ABSENT, not as a value of the wrong type.
  //
  // Every assertion above survives the presence check being removed: `undefined`
  // then reaches the kind predicate, which refuses it and names the field, so
  // the artifact is refused for the right reason by the wrong check. That is a
  // redundant guard reading as a load-bearing one -- and it is measurable only
  // here, in the WORDING, because the wording is the only thing the presence
  // check uniquely produces.
  //
  // It is not a cosmetic difference to the person reading it: `est_files is
  // undefined, not a whole number` sends a worker looking for a value they never
  // wrote, and `omits est_files` tells them what to add.
  {
    const gone = { ...full }; delete gone.est_files;
    const r = g(gone);
    check(r.findings.some(f => /omits est_files/.test(f)),
      "an omitted field is reported as omitted, not as a value of the wrong type",
      JSON.stringify(r.findings));
    check(!r.findings.some(f => /est_files is undefined/.test(f)),
      "control: and the kind check does not ALSO describe the value that is not there",
      JSON.stringify(r.findings));
  }
}

// ── The artifact the PRODUCER is specified to write ────────────────────────
//
// This fixture is copied from the phase plan that will emit design.md, not
// written to match this gate. That distinction is the whole point: every design
// fixture in this file until now was written to fit the checker, so the checker
// and its tests agreed with each other and disagreed with the artifact.
//
// Three disagreements, all found this way and all of which refused correct work:
// the producer writes `## Slices` holding `### Slice 1: ...` where this gate
// matched only `## Slice`; it labels the test plan `Test plan:` where this gate
// wanted `Tests:`; and it puts `Done when:` alone with a fenced command beneath
// it where this gate demanded a value on the same line.
{
  const documented = [
    "# Design", "", "## Approach", "", "Do the thing.", "", "## Slices", "",
    "### Slice 1: add the reader", "",
    "- Files: `src/build/sizing.mjs` (1.0), `test/build-sizing.test.mjs` (0.5)",
    "- Packages: `src/build`",
    "- Test plan: append to `test/build-sizing.test.mjs`", "",
    "Done when:", "", "```bash", "pnpm test -- test/build-sizing.test.mjs", "```", "",
  ].join("\n");
  const adir = join(dir, "documented");
  writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from(documented) });

  // BOTH expect shapes. The phase helpers return the requirement set and carry
  // no depth -- the depth is an INPUT to them -- so a gate demanding one throws
  // before reading the artifact and refuses its own documented callers.
  for (const [label, expect] of [["the helper's requirement set", { minCitationsPerClaim: 1, minClaims: 1 }],
                                 ["a depth-carrying expect", { depth: "standard" }]]) {
    let r = null, threw = null;
    try { r = reviewArtifact({ phase: "DESIGN", dir: adir, expect }); } catch (e) { threw = String(e.message); }
    check(threw === null, `reviewArtifact does not throw on ${label}`, String(threw));
    check(r?.ok === true, `and accepts the documented design artifact with ${label}`,
      JSON.stringify(r?.findings));
  }

  // AND IT STILL REFUSES, so accepting the producer's shape did not make the
  // gate permissive. Each of these is the documented shape with one thing removed.
  const g = (body) => {
    const d2 = join(dir, `doc${Math.random().toString(36).slice(2, 8)}`);
    writeArtifact({ dir: d2, phase: "DESIGN", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "DESIGN", dir: d2, expect: { depth: "standard" } });
  };
  check(g(documented.replace(/- Files:[^\n]*\n/, "")).ok === false,
    "control: the documented shape missing its Files line is refused");
  check(g(documented.replace(/Done when:[\s\S]*$/, "")).ok === false,
    "control: and missing its done condition");
  check(g("# Design\n\n## Approach\n\nprose only\n").ok === false,
    "control: and one with no slices at all");
}

// ── Every standard list marker is a claim ──────────────────────────────────
//
// `-`, `*` and `1.` were recognised; `+` and `1)` were not, so an uncited claim
// written with either was not a claim at all and the citation rule never saw it.
// A check that narrows its own input reports success on what it skipped.
{
  const adir = join(dir, "markers");
  const g = (body) => {
    writeArtifact({ dir: adir, phase: "RESEARCH", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "RESEARCH", dir: adir, expect: { depth: "standard" } });
  };
  for (const marker of ["-", "*", "+", "1.", "1)"]) {
    const r = g(`# r\n\n- a cited claim (src/x.mjs:1)\n${marker} an uncited claim\n`);
    check(r.ok === false, `an uncited claim written with "${marker}" is seen and refused`,
      JSON.stringify(r.findings));
  }
  // CONTROL: a cited claim in each marker still passes, so the markers were
  // added to the CLAIM test rather than everything being refused.
  for (const marker of ["+", "1)"])
    check(g(`# r\n\n${marker} a cited claim (src/x.mjs:1)\n`).ok === true,
      `control: a cited claim written with "${marker}" passes`);
}

// ── The gate applies the requirements it is GIVEN ──────────────────────────
//
// The phase helpers return requirement objects -- `{requireSliceList,
// requireDoneCondition, requireMeasuredContext, minSlices}` and
// `{minCitationsPerClaim, minClaims}` -- and carry no depth. A gate keyed on
// depth alone ignores everything its documented caller asked for, which is a
// quieter failure than refusing it: the checks simply do not run.
{
  const slice = "# d\n\n## Slices\n\n### Slice 1: x\n- Files: a\n- Packages: b\n- Test plan: c\n\n";
  const g = (body, expect) => {
    const d2 = join(dir, `req${Math.random().toString(36).slice(2, 8)}`);
    writeArtifact({ dir: d2, phase: "DESIGN", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "DESIGN", dir: d2, expect });
  };
  const fenced = slice + "Done when:\n\n```bash\npnpm test\n```\n";
  check(g(fenced, { requireMeasuredContext: true }).ok === false,
    "requireMeasuredContext true is honoured, with no depth in sight");
  check(g(fenced, { requireMeasuredContext: false }).ok === true,
    "control: and requireMeasuredContext false does not demand it");
  check(g(fenced, { minSlices: 2 }).ok === false, "minSlices is honoured");
  check(g(fenced, { minSlices: 1 }).ok === true, "control: and a satisfied minSlices passes");

  // THE DONE CONDITION IS MACHINE-CHECKABLE WHEN ASKED FOR. The contract defines
  // that as a fenced block whose first line is a command. The checker does not
  // RUN it and does not claim to -- it refuses a slice with no such block.
  check(g(slice + "Done when: someone approves\n", { requireDoneCondition: true }).ok === false,
    "a prose done-condition is refused when the caller asks for a checkable one");
  check(g(fenced, { requireDoneCondition: true }).ok === true,
    "control: and a fenced command satisfies it");
  check(g(slice + "Done when: someone approves\n", { depth: "standard" }).ok === true,
    "control: a caller that did not ask for it is not held to it");
}

// ── A claim is a bullet under `## Findings` ────────────────────────────────
//
// Scanning the whole document made every bullet a claim, so a valid report with
// a `## Limitations` note saying the network was unavailable was REFUSED for
// failing to cite it. The gate was rejecting the honest disclosure that research
// is supposed to carry.
{
  const g = (body, expect = { minClaims: 1 }) => {
    const d2 = join(dir, `sc${Math.random().toString(36).slice(2, 8)}`);
    writeArtifact({ dir: d2, phase: "RESEARCH", bytes: Buffer.from(body) });
    return reviewArtifact({ phase: "RESEARCH", dir: d2, expect });
  };
  check(g("# Research\n\n## Findings\n\n- a cited claim (src/x.mjs:1)\n\n## Limitations\n\n- no network was available\n").ok === true,
    "a bullet outside Findings is not a claim and does not need a citation");
  check(g("# Research\n\n## Findings\n\n- an uncited claim\n").ok === false,
    "control: an uncited bullet INSIDE Findings is still refused");
  check(g("# Research\n\n## Findings\n\n").ok === false,
    "control: and an empty Findings section is refused, not passed for having nothing to check");
  check(g("# Research\n\n- an uncited claim\n").ok === false,
    "control: a document with no Findings heading is still scanned whole");
  // minClaims is the caller's, not a constant here.
  check(g("# Research\n\n## Findings\n\n- a cited claim (src/x.mjs:1)\n", { minClaims: 2 }).ok === false,
    "and minClaims is the caller's number, not one fixed here");
}

// ── A sync failure inside the task's own tree is not swallowed ─────────────
//
// The blanket catch made an EIO on a parent INSIDE the tree read the same as a
// permission error on a directory above it, so writeArtifact returned a sha for
// an artifact whose tree was not durable. A guard that cannot fail is not a
// guard; this one was reporting success for exactly the storage failures it
// exists to notice.
//
// WHAT THIS DOES NOT ESTABLISH, stated rather than implied. The propagation
// itself is NOT tested: making an fsync fail on a directory inside the tree
// needs a fault-injection seam that `writeArtifact` does not have, and it takes
// its filesystem calls directly from node:fs. A manifest entry was written for
// it and removed again -- the stub made the code stricter, which nothing can
// observe, so it reported coverage that does not exist. An entry that cannot go
// red is worse than no entry, because it reads as a guard.
//
// What is assertable here is the ordinary path: the write succeeds through a
// chain of new directories and reads back under its recorded sha. Giving this
// function an injectable fs seam, as registryIo has for spawn, is the change
// that would make the failure path testable, and it is not this one.
{
  const deep = join(dir, "propagate", "a", "b", "artifacts");
  const w = writeArtifact({ dir: deep, phase: "DESIGN",
    bytes: Buffer.from("# d\n\n## Slice 1\nFiles: a\nPackages: b\nTests: c\nDone when: d\n") });
  check(readArtifact({ dir: deep, phase: "DESIGN", expectSha: w.sha256 }).ok === true,
    "control: a write through a new chain still succeeds and reads back");
}

// ── The eight refinements, each verified in both directions ────────────────
{
  const g = (phase, body, expect) => {
    const d2 = join(dir, `fu${Math.random().toString(36).slice(2, 8)}`);
    writeArtifact({ dir: d2, phase, bytes: Buffer.from(body) });
    return reviewArtifact({ phase, dir: d2, expect });
  };
  const SZ = { depth: "standard", est_files: 3, est_weighted_files: 4, est_packages: 1,
               est_slices: 2, risk_paths_touched: [], rationale: "x" };

  // A SIZING FIELD HAS A KIND, not merely a presence. `est_files: "lots"`
  // satisfied the contract, and the floors that read those numbers compare them.
  check(g("SIZING", JSON.stringify(SZ), {}).ok === true, "control: a well-typed sizing passes");
  for (const [field, bad] of [["est_files", "lots"], ["est_slices", 1.5], ["est_packages", -1],
                              ["risk_paths_touched", "none"], ["rationale", "  "]]) {
    const r = g("SIZING", JSON.stringify({ ...SZ, [field]: bad }), {});
    check(r.ok === false && r.findings.some(f => f.includes(field)),
      `sizing.json's ${field} as ${JSON.stringify(bad)} is refused, and the finding names it`,
      JSON.stringify(r.findings));
  }

  // A CITATION'S EXTENSION IS NOT LENGTH-CAPPED. `{0,5}` refused a correctly
  // cited claim for having a long filename.
  // BARE FILENAMES, because that is the only form the cap ever broke. A token
  // containing a slash matched the path alternative whatever its extension, so
  // `src/x.markdown:12` passed even while capped -- a fixture that cannot
  // exhibit the defect it was written for, and the sweep said so.
  for (const cite of ["x.markdown:12", "thing.typescript:9", "a.config.mjs:3", "x.yml:1"])
    check(g("RESEARCH", `# r\n\n## Findings\n\n- a claim (${cite})\n`, {}).ok === true,
      `the bare filename ${cite} is a citation`);
  // And the pathed form still works, which is the control for the above.
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (deep/path/to/thing.mts:99)\n", {}).ok === true,
    "control: and a pathed citation still is");
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim at 12:30\n", {}).ok === false,
    "control: and a bare time is still not one");

  // A CLAIM IS TOP-LEVEL. A nested bullet elaborating a cited claim was counted
  // as its own claim, so the more carefully a finding was broken down the more
  // likely the artifact was refused.
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (src/x.mjs:1)\n  - elaboration, uncited\n", {}).ok === true,
    "a nested bullet is not a claim of its own");
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (src/x.mjs:1)\n- another, uncited\n", {}).ok === false,
    "control: a second TOP-LEVEL bullet is, and is still required to cite");

  // minCitationsPerClaim IS APPLIED. It was accepted and ignored, so a claim with
  // one citation satisfied a caller asking for two -- an argument read but not
  // applied, which is worse than absent because the caller believes it took hold.
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (src/x.mjs:1)\n", { minCitationsPerClaim: 2 }).ok === false,
    "a caller asking for two citations is not satisfied by one");
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (src/x.mjs:1) (src/y.mjs:2)\n", { minCitationsPerClaim: 2 }).ok === true,
    "control: and two satisfy it");
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (src/x.mjs:1)\n", {}).ok === true,
    "control: while a caller that asks for nothing still gets the default of one");

  // THE SKIP IS THE CALLER'S FLAG. Keyed on a depth the helper does not supply,
  // this branch was unreachable from the documented caller.
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (src/x.mjs:1)\n", { skipped: true }).ok === false,
    "a caller declaring the phase skipped is refused without carrying a depth");
  check(g("RESEARCH", "# r\n\n## Findings\n\n- a claim (src/x.mjs:1)\n", { skipped: false }).ok === true,
    "control: and one declaring it not skipped is gated normally");

  // A FENCE MUST CLOSE. An unterminated fence satisfied the opening test, and the
  // rest of the document is then inside it.
  const sl = "# d\n\n## Slices\n\n### Slice 1: x\n- Files: a\n- Packages: b\n- Test plan: c\n\nDone when:\n\n";
  check(g("DESIGN", sl + "```bash\npnpm test\n", { requireDoneCondition: true }).ok === false,
    "an unterminated done-condition fence is refused");
  check(g("DESIGN", sl + "```bash\npnpm test\n```\n", { requireDoneCondition: true }).ok === true,
    "control: and a closed one passes");
}

// ── A temporary goes when close itself throws ──────────────────────────────
//
// Third leak in this family: the write was covered, then the rename, and the
// close between them was not. `closeSync` throws in its own right on some
// filesystems, where a deferred write error surfaces there.
{
  const adir = join(dir, "closefail");
  const w = writeArtifact({ dir: adir, phase: "DESIGN", bytes: Buffer.from("# d\n\n## Slice 1\nFiles: a\nPackages: b\nTests: c\nDone when: d\n") });
  check(readdirSync(adir).filter(f => f.includes(".tmp-")).length === 0,
    "control: an ordinary write leaves no temporary", readdirSync(adir).join(","));
  check(existsSync(w.path), "control: and produces the artifact");
}

db.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
