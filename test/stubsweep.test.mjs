// The stub sweep, and whether it can be shown to FAIL.
//
// This tool exists because three tests in one pull request proved a mechanism
// existed without proving it was reached. An instrument built to catch that shape,
// which itself only ever reports success, would be the same defect wearing a
// uniform — so the important assertions here are the ones that drive the runner
// end to end and require it to come back non-zero.
//
// The end-to-end cases build a THROWAWAY GIT REPOSITORY: a source file, a test
// that exercises it, and a manifest. That is what lets the real cleanliness guard
// stay strict, rather than being loosened to make itself testable.
import { applyEdit, validateManifest, classify, summarise, failedAssertions, describeMiss,
         reportedAnyAssertion, CAUGHT, NOT_CAUGHT, WRONG_RED, CRASHED, UNRUNNABLE, TIMED_OUT_EXIT }
  from "../src/stubsweep.mjs";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};
const threw = fn => { try { fn(); return null; } catch (e) { return e; } };
const RUNNER = resolve(fileURLToPath(new URL("../scripts/stub-sweep.mjs", import.meta.url)));

// --- applying an edit refuses anything ambiguous -------------------------------
{
  check(applyEdit("a b c", { find: "b", replace: "X" }) === "a X c", "an edit with one match applies");

  const none = threw(() => applyEdit("a b c", { find: "zzz", replace: "X" }));
  check(none && /appears 0 time/.test(none.message),
    "an anchor that matches nothing REFUSES rather than doing nothing quietly", String(none?.message));

  const many = threw(() => applyEdit("b a b", { find: "b", replace: "X" }));
  check(many && /appears 2 time/.test(many.message),
    "an anchor that matches twice refuses rather than picking one", String(many?.message));

  const empty = threw(() => applyEdit("abc", { find: "", replace: "X" }));
  check(empty !== null, "an empty anchor is refused", String(empty?.message));

  // Literal, not regex: a stub anchor is a chunk of source and source is full of
  // regex metacharacters.
  check(applyEdit("if (a.b) x", { find: "a.b", replace: "q" }) === "if (q) x",
    "anchors are literal, so dots and brackets in source do not behave as patterns");
}

// --- an anchor that overlaps itself is still ambiguous --------------------------
{
  // Advancing past a match by its own length skips overlapping occurrences, so a
  // repeated anchor reads as unique and gets applied to the first of several — the
  // precise ambiguity the count exists to refuse.
  const e = threw(() => applyEdit("aaa", { find: "aa", replace: "X" }));
  check(e && /appears 2 time/.test(e.message),
    "an anchor occurring at overlapping offsets is refused, not applied to the first",
    String(e?.message));
  const twice = threw(() => applyEdit("abab", { find: "ab", replace: "X" }));
  check(twice && /appears 2 time/.test(twice.message), "control: a plainly repeated anchor is refused too");
}

// --- a trailing newline is a terminator, not a line -----------------------------
{
  // `"a\nb\n"` is two lines. Splitting yields three segments because the last is
  // the empty string after the final terminator, and the inflated count also
  // pushed anchors past the threshold that enables the move hint.
  const src = "a\nb\nc\n";
  const m = String(threw(() => applyEdit(src, { find: "a\nZ\n", replace: "x" }))?.message ?? "");
  check(/of 2/.test(m), "a two-line anchor ending in a newline reports two lines, not three", m.split("\n")[1]);
}

// --- the move hint needs exactly ONE completed line ------------------------------
{
  // Zero completed lines means the divergence is INSIDE the first line, which is an
  // edit. Calling that a move collapses the two cases the hint exists to separate.
  const edited = String(threw(() => applyEdit("alphaZ\nbeta\ngamma\n",
    { find: "alphaY\nbeta\ngamma", replace: "x" }))?.message ?? "");
  check(!/moved rather than changed/.test(edited),
    "an anchor diverging inside its FIRST line is not called a move", edited.split("\n")[1]);
}

// --- a timed-out run is not a verdict -------------------------------------------
{
  // A test that prints the expected FAIL line and then hangs exits non-zero with
  // matching output, which would otherwise read as CAUGHT. The run never finished,
  // so what it would have reported is unknown.
  const v = classify({ controlExit: 0, hashChanged: true, restored: true, expectRed: "the guard holds",
                       stubExit: TIMED_OUT_EXIT, stubOutput: "PASS  a\nFAIL  the guard holds\n" });
  check(v.verdict === UNRUNNABLE,
    "a run killed for exceeding its time limit is UNRUNNABLE even when the output matches", JSON.stringify(v));
  check(/never completed/.test(v.why), "and says the run never completed", v.why);
}

// --- a rotted anchor says WHERE it stopped matching -----------------------------
{
  // The refusal is correct either way; this is about whether the next person
  // spends a minute or an hour. A manifest pins to source, so it rots against
  // refactors by design, and the useful thing a tool can do is say precisely what
  // it could not do rather than only that it could not.
  const source = "function f() {\n  const guard = true;\n  return guard;\n}\n";
  const e = threw(() => applyEdit(source, { find: "  const guard = false;", replace: "x" }));
  const msg = String(e?.message ?? "");
  check(/matched the first \d+ character/.test(msg),
    "a rotted anchor reports how far it matched", msg.split("\n")[1]);
  check(/const guard = true/.test(msg),
    "and shows what the file says there NOW", msg);
  check(/the anchor expected/.test(msg), "beside what the anchor expected", msg);

  const nowhere = threw(() => applyEdit(source, { find: "zzzz nothing", replace: "x" }));
  check(/no part of the anchor appears/.test(String(nowhere?.message)),
    "and an anchor with nothing in common says it may name the wrong file",
    String(nowhere?.message));

  check(describeMiss(source, "  const guard = true;\n  return guard;").length > 0,
    "control: describeMiss returns something even for a near-complete match");

  // A MOVED block and an EDITED line both produce a short prefix, and they need
  // different repairs. Diverging at anchor line 1 of several is a move; diverging
  // at the last line is an edit.
  const moved = String(threw(() => applyEdit(source,
    { find: "  const guard = true;\n  const extra = 1;\n  return guard;", replace: "x" }))?.message ?? "");
  check(/anchor line 2 of 3/.test(moved),
    "the divergence is reported as a position IN THE ANCHOR, not only a character count", moved.split("\n")[1]);
  check(/moved rather than changed/.test(moved),
    "and a first-line-only match is called out as a move", moved);

  const edited = String(threw(() => applyEdit(source,
    { find: "function f() {\n  const guard = true;\n  return nothing;", replace: "x" }))?.message ?? "");
  check(/anchor line 3 of 3/.test(edited),
    "control: diverging at the LAST anchor line is reported as such, not as a move", edited.split("\n")[1]);
  check(!/moved rather than changed/.test(edited),
    "and is NOT called a move", edited);
}

// --- a manifest that cannot produce a reading is refused ------------------------
{
  const ok = [{ name: "n", why: "w", test: "t", expectRed: "e", edits: [{ file: "f", find: "a", replace: "b" }] }];
  check(validateManifest(ok) === ok, "control: a well-formed manifest validates");

  const cases = [
    ["an empty manifest", [], /empty/],
    ["a missing name", [{ why: "w", test: "t", expectRed: "e", edits: [{ file: "f", find: "a", replace: "b" }] }], /needs a name/],
    ["a duplicate name", [ok[0], ok[0]], /duplicate/],
    ["a missing why", [{ name: "n", test: "t", expectRed: "e", edits: [{ file: "f", find: "a", replace: "b" }] }], /needs a "why"/],
    ["a missing expectRed", [{ name: "n", why: "w", test: "t", edits: [{ file: "f", find: "a", replace: "b" }] }], /expectRed/],
    ["no edits", [{ name: "n", why: "w", test: "t", expectRed: "e", edits: [] }], /at least one edit/],
    ["an edit that changes nothing", [{ name: "n", why: "w", test: "t", expectRed: "e", edits: [{ file: "f", find: "a", replace: "a" }] }], /itself/],
  ];
  for (const [what, m, re] of cases) {
    const e = threw(() => validateManifest(m));
    check(e !== null && re.test(e.message), `${what} is refused`, String(e?.message));
  }
}

// --- reading a run's assertions ------------------------------------------------
{
  const out = "PASS  one\nFAIL  two is wrong\n        detail\nPASS  three\n";
  check(JSON.stringify(failedAssertions(out)) === JSON.stringify(["two is wrong"]),
    "the failed assertions are read by name", JSON.stringify(failedAssertions(out)));
  check(reportedAnyAssertion(out) === true, "control: a normal run reports assertions");
  check(reportedAnyAssertion("TypeError: x is not a function\n    at y") === false,
    "and a stack trace with no assertions is recognised as reporting none");
}

// --- what the readings mean ----------------------------------------------------
{
  const base = { controlExit: 0, hashChanged: true, restored: true, expectRed: "the guard holds" };
  const red = "PASS  something else\nFAIL  the guard holds\n";

  check(classify({ ...base, stubExit: 1, stubOutput: red }).verdict === CAUGHT,
    "the named assertion failing is the only CAUGHT case");

  check(classify({ ...base, stubExit: 0, stubOutput: "PASS  the guard holds\n" }).verdict === NOT_CAUGHT,
    "a suite that stays green with the defect back in is NOT CAUGHT");
  check(/fixture/.test(classify({ ...base, stubExit: 0, stubOutput: "PASS  x\n" }).why),
    "and the message names the fixture as a cause, not only a missing assertion",
    classify({ ...base, stubExit: 0, stubOutput: "PASS  x\n" }).why);

  check(classify({ ...base, stubExit: 1, stubOutput: "PASS  a\nFAIL  something adjacent\n" }).verdict === WRONG_RED,
    "a failure in a DIFFERENT assertion leaves the property unmeasured");

  check(classify({ ...base, stubExit: 1, stubOutput: "TypeError: boom\n    at z" }).verdict === CRASHED,
    "a run that dies without reporting an assertion is a CRASH, not a pass-that-failed");

  check(classify({ ...base, controlExit: 1, stubExit: 1, stubOutput: red }).verdict === UNRUNNABLE,
    "a test that fails BEFORE stubbing makes every later reading meaningless");
  check(classify({ ...base, hashChanged: false, stubExit: 1, stubOutput: red }).verdict === UNRUNNABLE,
    "a stub whose file hash did not change never landed, so its red says nothing");
  check(classify({ ...base, restored: false, stubExit: 1, stubOutput: red }).verdict === UNRUNNABLE,
    "and a tree that did not restore would poison every reading after it");
}

// --- the sweep's own verdict ---------------------------------------------------
{
  check(summarise([{ verdict: CAUGHT }, { verdict: CAUGHT }]).ok === true, "all caught passes");
  for (const v of [NOT_CAUGHT, WRONG_RED, CRASHED, UNRUNNABLE])
    check(summarise([{ verdict: CAUGHT }, { verdict: v }]).ok === false,
      `a single ${v} fails the sweep — there is no warning level`);
  check(summarise([]).ok === false,
    "and a sweep that measured NOTHING fails, rather than reporting success having done nothing");
}

// --- end to end: the runner must be able to come back non-zero -----------------
{
  // A throwaway repository, so the real cleanliness guard stays strict.
  const root = mkdtempSync(join(tmpdir(), "sweep-e2e-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"),
    `export function safe(v) {\n  if (typeof v === "object") throw new Error("not a scalar");\n  return String(v);\n}\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { safe } from "../src/thing.mjs";\n` +
    `let fail = 0;\n` +
    `const check = (ok, name) => { console.log((ok ? "PASS  " : "FAIL  ") + name); if (!ok) fail++; };\n` +
    `let threwFor = null; try { safe({}); } catch (e) { threwFor = e; }\n` +
    `check(threwFor !== null, "an object is refused");\n` +
    `check(safe(3) === "3", "a scalar still works");\n` +
    `process.exit(fail ? 1 : 0);\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "sweep@example.invalid");
  git("config", "user.name", "sweep");

  const writeManifest = stubs => writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = ${JSON.stringify(stubs, null, 2)};\n`);
  const commit = () => { git("add", "-A"); git("commit", "-q", "-m", "fixture"); };
  const run = () => {
    const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
      env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
    return { exit: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  };
  const guard = { file: "src/thing.mjs", find: `  if (typeof v === "object") throw new Error("not a scalar");\n`, replace: "" };

  // 1. A real stub, caught. Establishes the runner can pass at all.
  writeManifest([{ name: "guard", why: "remove the scalar guard", test: "test/thing.test.mjs",
                   expectRed: "an object is refused", edits: [guard] }]);
  commit();
  const caught = run();
  check(caught.exit === 0, "control: a stub the test catches passes the sweep", caught.out.slice(-300));
  check(/CAUGHT/.test(caught.out), "and says so");

  // The file must be byte-identical afterwards. This is the property whose absence
  // silently destroyed real work when a hand-run sweep used git checkout instead.
  const after = createHash("sha256").update(readFileSync(join(root, "src", "thing.mjs"))).digest("hex");
  const expected = createHash("sha256")
    .update(`export function safe(v) {\n  if (typeof v === "object") throw new Error("not a scalar");\n  return String(v);\n}\n`)
    .digest("hex");
  check(after === expected, "and the source is restored byte for byte");

  // 2. THE ONE THAT MATTERS: a stub nothing catches must FAIL the sweep.
  writeManifest([{ name: "cosmetic", why: "change something no test observes", test: "test/thing.test.mjs",
                   expectRed: "an object is refused",
                   edits: [{ file: "src/thing.mjs", find: "  return String(v);", replace: "  return String(v); // noop" }] }]);
  commit();
  const uncaught = run();
  check(uncaught.exit === 1, "a stub NO test catches fails the sweep", `exit=${uncaught.exit}`);
  check(/NOT_CAUGHT/.test(uncaught.out), "and is reported as NOT_CAUGHT", uncaught.out.slice(-300));

  // 3. A stub that breaks a different assertion is not success either.
  writeManifest([{ name: "adjacent", why: "break an unrelated assertion", test: "test/thing.test.mjs",
                   expectRed: "an object is refused",
                   edits: [{ file: "src/thing.mjs", find: "  return String(v);", replace: "  return String(v) + \"!\";" }] }]);
  commit();
  const wrong = run();
  check(wrong.exit === 1, "a stub that reddens a DIFFERENT assertion fails the sweep", `exit=${wrong.exit}`);
  check(/WRONG_RED/.test(wrong.out), "and is reported as WRONG_RED, not as caught", wrong.out.slice(-300));

  // 4. A stub that makes the test die is not a pass-that-failed.
  writeManifest([{ name: "crash", why: "make the module fail to parse", test: "test/thing.test.mjs",
                   expectRed: "an object is refused",
                   edits: [{ file: "src/thing.mjs", find: "export function safe(v) {", replace: "export function safe(v) { (" }] }]);
  commit();
  const crash = run();
  check(crash.exit === 1, "a stub that makes the test CRASH fails the sweep", `exit=${crash.exit}`);
  check(/CRASHED/.test(crash.out), "and is reported as CRASHED rather than as a failing assertion", crash.out.slice(-300));

  // 4b. A control that already fails stops the entry BEFORE production files are
  //     touched. classify would return UNRUNNABLE whatever happened next, so
  //     stubbing and waiting out a second timeout buys nothing and runs
  //     deliberately broken code for no reading.
  writeFileSync(join(root, "src", "thing.mjs"), `export function safe(v) { return "always broken"; }\n`);
  writeManifest([{ name: "control-fails", why: "irrelevant; the control is already red", test: "test/thing.test.mjs",
                   expectRed: "an object is refused",
                   edits: [{ file: "src/thing.mjs", find: "always broken", replace: "still broken" }] }]);
  commit();
  const beforeControl = readFileSync(join(root, "src", "thing.mjs"), "utf8");
  const badControl = run();
  check(badControl.exit === 1, "an entry whose control already fails does not pass the sweep", `exit=${badControl.exit}`);
  check(/UNRUNNABLE/.test(badControl.out), "and is UNRUNNABLE", badControl.out.slice(-260));
  check(readFileSync(join(root, "src", "thing.mjs"), "utf8") === beforeControl,
    "and the production file was never stubbed, because the reading was already known");

  // Put the working source back for the remaining cases.
  writeFileSync(join(root, "src", "thing.mjs"),
    `export function safe(v) {\n  if (typeof v === "object") throw new Error("not a scalar");\n  return String(v);\n}\n`);
  commit();

  // 5. A rotted anchor is refused rather than silently skipped.
  writeManifest([{ name: "rotted", why: "an anchor that no longer exists", test: "test/thing.test.mjs",
                   expectRed: "an object is refused",
                   edits: [{ file: "src/thing.mjs", find: "this text is not in the file", replace: "x" }] }]);
  commit();
  const rotted = run();
  check(rotted.exit === 1, "a manifest that has rotted against the code fails the sweep", `exit=${rotted.exit}`);
  check(/UNRUNNABLE|appears 0 time/.test(rotted.out), "and says the anchor matched nothing", rotted.out.slice(-300));

  // 6. And it refuses a dirty tree outright, which is the precondition that once
  //    cost real uncommitted work.
  writeFileSync(join(root, "src", "thing.mjs"),
    readFileSync(join(root, "src", "thing.mjs"), "utf8") + "\n// uncommitted\n");
  const dirty = run();
  check(dirty.exit === 2, "a dirty working tree is refused before anything is touched", `exit=${dirty.exit}`);
  check(/uncommitted changes/.test(dirty.out), "and says why", dirty.out.slice(-200));
  check(/uncommitted/.test(readFileSync(join(root, "src", "thing.mjs"), "utf8")),
    "and the uncommitted work is still there afterwards");
}

// --- a killed run must not leave the tree broken -------------------------------
{
  // The docblock CLAIMED a killed run cannot leave a stub behind. Taking a
  // snapshot is what makes that possible; it is not what makes it true. Without
  // handlers, a Ctrl-C or a cancelled workflow exits between writing the stub and
  // restoring it, leaving a deliberately broken production file in the tree — and
  // the next sweep then refuses because the tree is dirty, which reads as the
  // guard working when it is really the wreckage of the last run.
  //
  // Driven by sending a REAL signal, and synchronised on a marker file rather than
  // on a sleep, so it is not a timing race.
  const root = mkdtempSync(join(tmpdir(), "sweep-sig-"));
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  const SOURCE = `export const guard = true;\nexport function f() { return guard ? "ok" : "broken"; }\n`;
  writeFileSync(join(root, "src", "thing.mjs"), SOURCE);
  // OUTSIDE the repository. Kept inside, the marker is an untracked file, and the
  // final assertion — that the tree is clean — would fail on the test's own
  // artefact while reporting it as the sweep's wreckage.
  const marker = join(mkdtempSync(join(tmpdir(), "sweep-marker-")), "started");
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
    `import { f } from "../src/thing.mjs";\n` +
    `appendFileSync(${JSON.stringify(marker)}, "run\\n");\n` +
    `console.log(f() === "ok" ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    // Blocks the thread, so the runner is genuinely mid-test when the signal lands.
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);\n` +
    `process.exit(f() === "ok" ? 0 : 1);\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "remove the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const child = spawnSync(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const { readFileSync, existsSync } = require("node:fs");
    const p = spawn(process.execPath, [${JSON.stringify(RUNNER)}], {
      cwd: ${JSON.stringify(root)},
      env: { ...process.env, STUB_SWEEP_ROOT: ${JSON.stringify(root)},
             STUB_MANIFEST: ${JSON.stringify(join(root, "test", "stub-manifest.mjs"))} },
      stdio: "ignore" });
    // Wait until the SECOND run has begun: the first is the unstubbed control, so
    // only the second has a stub on disk to lose.
    const waitForStubbedRun = setInterval(() => {
      const runs = existsSync(${JSON.stringify(marker)})
        ? readFileSync(${JSON.stringify(marker)}, "utf8").split("\\n").filter(Boolean).length : 0;
      if (runs >= 2) { clearInterval(waitForStubbedRun); p.kill("SIGTERM"); }
    }, 50);
    p.on("exit", () => { clearInterval(waitForStubbedRun); process.exit(0); });
  `], { encoding: "utf8", timeout: 60_000 });

  check(child.status === 0, "control: the harness ran and killed the sweep mid-stub", String(child.stderr).slice(0, 200));
  const afterKill = readFileSync(join(root, "src", "thing.mjs"), "utf8");
  check(afterKill === SOURCE,
    "a sweep killed mid-stub restores the source before exiting", JSON.stringify(afterKill));
  check(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
    "so the tree is clean and the NEXT sweep is not blocked by the last one's wreckage");
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
