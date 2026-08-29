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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};
const threw = fn => { try { fn(); return null; } catch (e) { return e; } };

// FIXTURES CLEAN UP AFTER THEMSELVES.
//
// Each block builds a throwaway git repository, and the sweep runs this file twice
// per manifest entry -- 24 directories a run, about 1,600 a sweep. Left behind they
// had reached 7,445 directories and 13 GB of temp on this machine, MEASURED, which
// is litter in a shared location by exactly the argument this tool makes about
// ignored artifacts.
//
// Registered rather than removed per block, because a block that fails an assertion
// still has to leave the machine as it found it, and `process.exit` at the end of
// this file runs exit handlers.
const TEMPS = [];
const tmpRoot = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); TEMPS.push(d); return d; };
process.on("exit", () => {
  // Best effort, and deliberately silent: a fixture that cannot be removed must not
  // turn a green suite red, and must not mask the verdict this file exists to give.
  for (const d of TEMPS) { try { rmSync(d, { recursive: true, force: true }); } catch { /* leave it */ } }
});
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
    // A truthy non-string reaches `join` in the runner and throws a raw TypeError
    // before the uncaughtException handler is installed — the process then dies
    // with status 1 and a stack trace, indistinguishable from a stub that was not
    // caught, when it is really a malformed manifest.
    ["a non-string edit path", [{ name: "n", why: "w", test: "t", expectRed: "e", edits: [{ file: ["f"], find: "a", replace: "b" }] }], /non-empty string "file"/],
    ["a numeric edit path", [{ name: "n", why: "w", test: "t", expectRed: "e", edits: [{ file: 7, find: "a", replace: "b" }] }], /non-empty string "file"/],
    ["a blank edit path", [{ name: "n", why: "w", test: "t", expectRed: "e", edits: [{ file: "   ", find: "a", replace: "b" }] }], /non-empty string "file"/],
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

// --- an assertion is recognised by its DELIMITER --------------------------------
{
  // A bare `FAIL` prefix also matches ordinary diagnostics. A crashing test that
  // prints one containing the expected text would then be read as the named
  // assertion failing, so a run where no assertion executed reports CAUGHT.
  const noisy = "FAILURE: the guard holds\nFAILED 2\nFAIL: the guard holds\n";
  check(failedAssertions(noisy).length === 0,
    "lines beginning with FAIL but lacking the two-space delimiter are not assertions",
    JSON.stringify(failedAssertions(noisy)));
  check(reportedAnyAssertion(noisy) === false,
    "and such a run counts as having reported no assertions at all");

  check(JSON.stringify(failedAssertions("FAIL  the guard holds\n")) === JSON.stringify(["the guard holds"]),
    "control: a properly delimited assertion is still read");

  // End to end through the classifier, which is where it would have mattered.
  const v = classify({ controlExit: 0, hashChanged: true, restored: true, expectRed: "the guard holds",
                       stubExit: 1, stubOutput: noisy });
  check(v.verdict === CRASHED,
    "so a crash printing FAILURE: <expected text> is CRASHED, not CAUGHT", JSON.stringify(v));
}

// --- expectRed must be a non-empty STRING ---------------------------------------
{
  // `String.prototype.includes` coerces, so `expectRed: []` becomes "" and matches
  // every failing assertion — the entry then reports CAUGHT whatever went red.
  const base = { name: "n", why: "w", test: "t", edits: [{ file: "f", find: "a", replace: "b" }] };
  for (const [what, v] of [["an array", []], ["a number", 1], ["an object", {}], ["an empty string", ""], ["whitespace", "   "]]) {
    const e = threw(() => validateManifest([{ ...base, expectRed: v }]));
    check(e !== null && /non-empty string/.test(e.message), `expectRed as ${what} is refused`, String(e?.message));
  }
  check(validateManifest([{ ...base, expectRed: "x" }]).length === 1, "control: a real string is accepted");
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
  const root = tmpRoot("sweep-e2e-");
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
  const root = tmpRoot("sweep-sig-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  const SOURCE = `export const guard = true;\nexport function f() { return guard ? "ok" : "broken"; }\n`;
  writeFileSync(join(root, "src", "thing.mjs"), SOURCE);
  // OUTSIDE the repository. Kept inside, the marker is an untracked file, and the
  // final assertion — that the tree is clean — would fail on the test's own
  // artefact while reporting it as the sweep's wreckage.
  const markerDir = tmpRoot("sweep-marker-");
  const marker = join(markerDir, "started");
  // Outside the fixture repository, so neither file shows as untracked and makes
  // the clean-tree assertion fail on the test's own artefacts.
  const helperPath = join(markerDir, "helper.mjs");
  writeFileSync(helperPath,
    `import { appendFileSync } from "node:fs";\n` +
    `setTimeout(() => appendFileSync(process.argv[2], "helper-ran\\n"), 3000);\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { appendFileSync } from "node:fs";\n` +
    `import { f } from "../src/thing.mjs";\n` +
    `appendFileSync(${JSON.stringify(marker)}, "run\\n");\n` +
    // A helper in the test's process tree. If only the direct pid is killed, this
    // survives and writes its marker after the sweep has exited.
    //
    // A real FILE rather than an inline `-e` string: the first version nested
    // JSON.stringify twice, so the helper appended to a path with literal quotes
    // in its name and the marker was never touched — the assertion could not fail,
    // and the stub of the process-group kill proved it.
    `import { spawn } from "node:child_process";\n` +
    `spawn(process.execPath, [${JSON.stringify(helperPath)}, ${JSON.stringify(marker)}], { stdio: "ignore" });\n` +
    // Recorded AFTER the spawn, so the harness can wait for the helper to exist
    // before signalling. Without it the kill can land first and the helper never
    // gets created — the assertion then passes for a run that never had a
    // grandchild to lose.
    `appendFileSync(${JSON.stringify(marker)}, "helper-spawned\\n");\n` +
    `console.log(f() === "ok" ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    // Blocks the thread, so the runner is genuinely mid-test when the signal lands.
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);\n` +
    // Only reached if the child was NOT killed. Its absence is how we prove the
    // signal handler ended the child rather than only restoring the tree and
    // leaving it running with its timeout timer dead alongside the parent.
    `appendFileSync(${JSON.stringify(marker)}, "finished\\n");\n` +
    `process.exit(f() === "ok" ? 0 : 1);\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "remove the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const runnerLog = join(markerDir, "runner.log");
  const child = spawnSync(process.execPath, ["-e", `
    const { spawn } = require("node:child_process");
    const { readFileSync, existsSync } = require("node:fs");
    const p = spawn(process.execPath, [${JSON.stringify(RUNNER)}], {
      cwd: ${JSON.stringify(root)},
      env: { ...process.env, STUB_SWEEP_ROOT: ${JSON.stringify(root)},
             STUB_MANIFEST: ${JSON.stringify(join(root, "test", "stub-manifest.mjs"))} },
      // CAPTURED, not discarded. When this block failed I could not tell why,
      // because the one process that knew had its output sent to /dev/null.
      stdio: ["ignore", "pipe", "pipe"] });
    let runnerOut = "";
    p.stdout.on("data", d => { runnerOut += d; });
    p.stderr.on("data", d => { runnerOut += d; });
    // Wait until the SECOND run has begun: the first is the unstubbed control, so
    // only the second has a stub on disk to lose.
    const waitForStubbedRun = setInterval(() => {
      // ONLY the start markers. Counting every non-empty line broke the moment the
      // fixture also wrote a "finished" line: the control run alone then looked
      // like two runs, so the kill landed BETWEEN runs with no stub on disk, and
      // the assertion measured a control that had completed normally.
      const text = existsSync(${JSON.stringify(marker)})
        ? readFileSync(${JSON.stringify(marker)}, "utf8") : "";
      const lines = text.split("\\n");
      const runs = lines.filter(l => l === "run").length;
      const helpers = lines.filter(l => l === "helper-spawned").length;
      // BOTH conditions: the stubbed run has begun AND its helper exists. Waiting
      // only on the run count let the signal land before the grandchild was
      // created, so there was nothing for the group kill to prove.
      if (runs >= 2 && helpers >= 2) { clearInterval(waitForStubbedRun); p.kill("SIGTERM"); }
    }, 50);
    p.on("exit", () => {
      clearInterval(waitForStubbedRun);
      // argv[1], not argv[2]. With \`node -e "code" arg\` there is no script path in
      // argv, so the first extra argument lands at index 1 — reading index 2 gave
      // undefined and threw INSIDE the exit handler, which is why this block could
      // not say what the runner did.
      require("node:fs").writeFileSync(process.argv[1], runnerOut);
      process.exit(0);
    });
  `, runnerLog], { encoding: "utf8", timeout: 60_000 });

  const runnerSaid = existsSync(runnerLog) ? readFileSync(runnerLog, "utf8") : "(no output captured)";
  check(child.status === 0, "control: the harness ran and killed the sweep mid-stub",
    `${String(child.stderr).slice(0, 200)}\n        runner said: ${runnerSaid.slice(0, 400)}`);
  const afterKill = readFileSync(join(root, "src", "thing.mjs"), "utf8");
  check(afterKill === SOURCE,
    "a sweep killed mid-stub restores the source before exiting", JSON.stringify(afterKill));
  check(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
    "so the tree is clean and the NEXT sweep is not blocked by the last one's wreckage");

  // The CHILD must be dead too. Restoring the tree and exiting while the test runs
  // on leaves it producing side effects after the sweep has reported it finished —
  // and its timeout timer died with the parent, so nothing will ever stop it.
  // COUNTS, not presence. The control run legitimately finishes, so asserting
  // that "finished" never appears asserts something false — a started run that
  // never finished is the signal, which is one fewer finish than start.
  const log = readFileSync(marker, "utf8").split("\n").filter(Boolean);
  const starts = log.filter(l => l === "run").length;
  const finishes = log.filter(l => l === "finished").length;
  check(starts === 2, "control: the stubbed run really did begin",
    `${JSON.stringify(log)}\n        runner said: ${runnerSaid.slice(0, 500)}`);
  check(finishes === starts - 1,
    "and the test process was killed rather than left running after the sweep exited",
    `${starts} started, ${finishes} finished`);

  // THE WHOLE PROCESS TREE, not just the direct child. A helper the test spawned
  // outlives a kill aimed at the test's own pid, and keeps producing side effects
  // against a tree that has since been restored — with no timer left anywhere to
  // stop it, because the sweep's timer died with the sweep.
  //
  // The helper writes its marker after a delay, so the file's contents at the end
  // say whether it survived.
  // WAIT PAST THE HELPER'S OWN DELAY before reading. Checking immediately passes
  // whether or not the helper survived, because it would not have written yet —
  // a test that cannot fail, and the stub of the process-group kill proved it.
  execFileSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4500)"]);
  // COUNTS again, for the same reason as the finishes above. The CONTROL run
  // completes normally, so its helper legitimately writes — asserting that
  // "helper-ran" never appears asserts something false. The signal is one fewer
  // helper completion than helper spawn.
  const after = readFileSync(marker, "utf8").split("\n").filter(Boolean);
  const spawned = after.filter(l => l === "helper-spawned").length;
  const ran = after.filter(l => l === "helper-ran").length;
  check(spawned === 2, "control: both runs spawned a helper", JSON.stringify(after));
  check(ran === spawned - 1,
    "and the helper the STUBBED test spawned was killed with it, rather than outliving the sweep",
    `${spawned} spawned, ${ran} ran`);
}

// --- an edit that resolves outside the repository is refused --------------------
{
  // `join(ROOT, file)` happily produces a path outside the tree when the entry
  // contains `..`, and the runner would snapshot, modify and restore a file the
  // git guard cannot see — damaging a sibling project with nothing noticing.
  const root = tmpRoot("sweep-escape-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const a = 1;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"), `console.log("PASS  the guard holds");\nprocess.exit(0);\n`);
  // A real sibling, outside the repository, that must be left alone.
  const outsideDir = tmpRoot("sweep-sibling-");
  const outside = join(outsideDir, "victim.mjs");
  const VICTIM = `export const untouched = true;\n`;
  writeFileSync(outside, VICTIM);

  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "escape", why: "reach outside the tree", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: ${JSON.stringify("../" + basename(outsideDir) + "/victim.mjs")},\n` +
    `            find: "export const untouched = true;", replace: "export const untouched = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  check(r.status === 2, "a manifest edit resolving outside the repository is refused outright", String(r.status));
  check(/outside the repository/.test(`${r.stdout ?? ""}${r.stderr ?? ""}`), "and says so", `${r.stderr ?? ""}`.slice(0, 200));
  check(readFileSync(outside, "utf8") === VICTIM,
    "and the file outside the tree is untouched", readFileSync(outside, "utf8"));
}

// --- a stubbed test's side effects on the wider tree are caught -----------------
{
  // The startup guard proves the tree was clean when the sweep began. It cannot see
  // what deliberately broken code did while it ran, and the entry would otherwise
  // report CAUGHT and exit 0 with the repository dirty.
  const root = tmpRoot("sweep-side-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    // ONLY on the stubbed run. Littering on both meant the CONTROL run dirtied the
    // tree, the pre-stub check caught it, and this block passed on a verdict it
    // does not name — a stub of the post-run check left it green. The post-run
    // check is what this block is about, so only the stubbed run may litter.
    `if (!guard) writeFileSync(new URL("../src/litter.mjs", import.meta.url).pathname, "// left behind\\n");\n` +
    `process.exit(guard ? 0 : 1);\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 1, "a stub whose test litters the repository does not pass the sweep", `exit=${r.status}`);
  check(/UNRUNNABLE/.test(out), "and the reading is void rather than reported as CAUGHT", out.slice(-300));
  check(existsSync(join(root, "src", "litter.mjs")),
    "control: the side effect really happened, so the check had something to find");
}

// --- a verdict line survives a flood of diagnostics -----------------------------
{
  // A test that prints its named FAIL and then a megabyte of noise would have had
  // the evidence scrolled out of the capped tail, and the entry reported CRASHED —
  // failing the sweep even though the assertion did catch the stub.
  const root = tmpRoot("sweep-flood-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { guard } from "../src/thing.mjs";\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    `if (!guard) { const noise = "x".repeat(64 * 1024);\n` +
    `  for (let i = 0; i < 48; i++) console.log(noise); }\n` +
    // `process.exitCode`, NOT `process.exit`. The latter does not flush pending
    // stdout writes, so the flood this fixture exists to produce never reached the
    // runner — and the verdict line survived for a reason that had nothing to do
    // with the mechanism under test. The stub of that mechanism stayed green.
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28,
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 0,
    "a named assertion still counts when the failure buries it under 1.5 MiB of noise", `exit=${r.status}`);
  check(/CAUGHT/.test(out), "and the verdict is CAUGHT rather than CRASHED", out.slice(-300));
}

// --- a control run that dirties the tree voids the reading ----------------------
{
  // The start-up guard proves the tree was clean when the SWEEP began. It does not
  // prove it was clean when THIS stub was applied — and a control run that leaves
  // an untracked cache changes what the stubbed run does. If the stubbed run then
  // consumes and deletes it, the post-entry check sees a clean tree and reports
  // CAUGHT for a stub that would not have been caught from a clean start.
  const root = tmpRoot("sweep-precheck-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  // The test litters on the PASSING (control) run and tidies up on the failing one.
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { writeFileSync, rmSync, existsSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `const cache = new URL("../src/cache.tmp", import.meta.url).pathname;\n` +
    `if (guard) writeFileSync(cache, "cached\\n");\n` +
    `else if (existsSync(cache)) rmSync(cache);\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 1, "a control run that dirties the tree does not yield a passing sweep", `exit=${r.status}`);
  check(/UNRUNNABLE/.test(out), "and the reading is void rather than CAUGHT", out.slice(-320));
  check(/control run left the tree dirty/.test(out), "and says the control was what made the mess", out.slice(-320));
}

// --- only FAIL lines spend the assertion budget ---------------------------------
{
  // A suite printing many passing assertions before the relevant failure would
  // otherwise exhaust the budget on PASS lines, and the named FAIL — the one thing
  // the retention exists to preserve — still scrolls out of the capped tail.
  const root = tmpRoot("sweep-budget-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { guard } from "../src/thing.mjs";\n` +
    `if (!guard) { for (let i = 0; i < 25000; i++) console.log("PASS  filler " + i); }\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    `if (!guard) { const noise = "x".repeat(64 * 1024); for (let i = 0; i < 32; i++) console.log(noise); }\n` +
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28,
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 0,
    "25,000 passing assertions before the failure do not crowd the named FAIL out", `exit=${r.status}`);
  check(/CAUGHT/.test(out), "and the verdict is CAUGHT", out.slice(-320));
}

// --- an endless line without a newline cannot exhaust the heap ------------------
{
  // `partial` holds an incomplete line until a newline arrives. Unbounded, a test
  // emitting a long diagnostic with no newline grows it for ever — it never
  // reaches the split, so the output cap never sees it, and the heap goes before
  // the timer or the restore handlers run. Which leaves the stub on disk: the very
  // failure the cap exists to prevent, arriving through the buffer that implements it.
  const root = tmpRoot("sweep-noline-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  const SOURCE = `export const guard = true;\n`;
  writeFileSync(join(root, "src", "thing.mjs"), SOURCE);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { guard } from "../src/thing.mjs";\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    // No newlines at all: 32 MiB of one line.
    `if (!guard) { const chunk = "y".repeat(1 << 20); for (let i = 0; i < 32; i++) process.stdout.write(chunk); }\n` +
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28,
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 0, "32 MiB with no newline is survived and the stub still caught", `exit=${r.status}`);
  check(readFileSync(join(root, "src", "thing.mjs"), "utf8") === SOURCE,
    "and the source is restored, rather than left stubbed by a runner that died");
}

// --- a manifest path that is not URL-safe still imports -------------------------
{
  // On win32 `resolve()` yields `C:\repo\...` and `import()` reads `c:` as an
  // unsupported scheme. The same class is reachable on POSIX: a `#` in a directory
  // name is a URL FRAGMENT, so importing the raw path silently addresses a
  // different file — or none. `pathToFileURL` encodes both.
  const root = tmpRoot("sweep-url#frag-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { guard } from "../src/thing.mjs";\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  check(root.includes("#"), "control: the fixture's path really does contain a URL fragment character", root);
  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 0, "a manifest under a path that is not URL-safe still loads and runs", `exit=${r.status}\n        ${out.slice(-260)}`);
  check(/CAUGHT/.test(out), "and the stub is caught", out.slice(-200));
}

// --- an edit inside the git directory is refused --------------------------------
{
  // Inside the root, so containment accepts it — and invisible to `git status`, so
  // a failed restore there would corrupt the repository with nothing noticing.
  const root = tmpRoot("sweep-gitdir-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"), `console.log("PASS  the guard holds");\nprocess.exitCode = 0;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "meta", why: "edit git metadata", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: ".git/config", find: "[core]", replace: "[cxre]" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  const cfgBefore = readFileSync(join(root, ".git", "config"), "utf8");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 2, "an edit inside the git directory is refused outright", `exit=${r.status}`);
  check(/git directory/.test(out), "and says why", out.slice(-240));
  check(readFileSync(join(root, ".git", "config"), "utf8") === cfgBefore,
    "and the git metadata is untouched");
}

// --- an IGNORED artifact the control creates is still a side effect -------------
{
  // `git status --porcelain` reports clean both times when the artifact is
  // gitignored, so the stub reads as CAUGHT for a run that would not have been
  // caught from an untouched tree. This repository ignores exactly that kind of file.
  const root = tmpRoot("sweep-ignored-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, ".gitignore"), "*.cache\n");
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    // The CONTROL run leaves an ignored artifact behind.
    `if (guard) writeFileSync(new URL("../src/build.cache", import.meta.url).pathname, "x\\n");\n` +
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(existsSync(join(root, "src", "build.cache")),
    "control: the control run really did leave an ignored artifact");
  check(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
    "control: and a plain `git status` calls that tree clean, which is the whole problem");
  check(r.status === 1, "an ignored artifact left by the control run voids the reading", `exit=${r.status}`);
  check(/UNRUNNABLE/.test(out), "and it is reported UNRUNNABLE", out.slice(-320));
}

// --- what reaping does NOT guarantee, stated rather than asserted ---------------
{
  // There is no test here, and that is the finding.
  //
  // A test that spawns a background worker and then exits NORMALLY leaves it
  // running, and the sweep cannot reliably stop it. Measured on this build rather
  // than reasoned:
  //
  //   · after the child exits, `process.kill(-pgid)` returns ESRCH and
  //     `pgrep -g <pgid>` finds nothing — the group is gone with its leader;
  //   · sampling `pgrep -P` WHILE the child lives does find the worker, and the
  //     pid is correct — it matches the pid the worker reports for itself;
  //   · and `process.kill(<that pid>, "SIGKILL")` then returns ESRCH anyway,
  //     while the worker demonstrably survives and writes two seconds later.
  //
  // The third reading is the one I cannot explain, and an unexplained mechanism is
  // not one to build a guarantee on. The sampling stays in as best effort, because
  // it costs nothing and does reap the ordinary cases; what is NOT here is an
  // assertion claiming a property the runner cannot keep.
  //
  // The backstop is the tree check, and its limit is honest too: it reads after
  // the test exits, so a worker that writes later is outside what a synchronous
  // sweep can see. Anyone extending this should know that before relying on it.
  check(true, "documented: a worker outliving a normally-completed test is NOT reaped reliably");
}

// --- a SEPARATE git directory inside the tree is excluded ----------------------
{
  // `.git` is a pointer FILE in a worktree or a separate-git-dir repository —
  // measured on this machine at 63 bytes. Hard-coding `<root>/.git` therefore
  // guards a pointer while the real metadata sits elsewhere, and when that
  // elsewhere is an IGNORED path inside the tree, `git status` cannot see a failed
  // restore there either.
  const root = tmpRoot("sweep-sepgit-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"), `console.log("PASS  the guard holds");\nprocess.exitCode = 0;\n`);
  writeFileSync(join(root, ".gitignore"), ".meta/\n");
  // The manifest is written BEFORE the commit. Written after, it is untracked, the
  // runner refuses for a DIRTY TREE, and the exit code is 2 either way — so the
  // first assertion passes for a reason that has nothing to do with git metadata.
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "meta", why: "edit the real git metadata", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: ".meta/config", find: "[core]", replace: "[cxre]" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  // Move the metadata under an IGNORED path inside the tree and leave a pointer,
  // which is exactly the shape `git init --separate-git-dir` produces.
  execFileSync("mv", [join(root, ".git"), join(root, ".meta")]);
  writeFileSync(join(root, ".git"), `gitdir: ${join(root, ".meta")}\n`);
  check(execFileSync("git", ["rev-parse", "--absolute-git-dir"], { cwd: root, encoding: "utf8" }).trim()
          === realpathSync(join(root, ".meta")),
    "control: the fixture really does keep its metadata outside `.git`");
  check(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
    "control: and its tree is clean, so a refusal cannot be about dirtiness");
  const cfgBefore = readFileSync(join(root, ".meta", "config"), "utf8");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 2, "an edit inside a SEPARATE git directory is refused", `exit=${r.status}\n        ${out.slice(-260)}`);
  check(/git directory/.test(out), "and says so", out.slice(-240));
  check(readFileSync(join(root, ".meta", "config"), "utf8") === cfgBefore,
    "and the real metadata is untouched");
}

// --- a line forged by INTERLEAVING cannot be classified -------------------------
{
  // The raw capture is the two streams as they arrived, so a line can appear in it
  // that neither stream emitted: stdout writes `FAIL  wrong assertion` with no
  // newline, stderr writes ` the guard holds\n`, and the concatenation reads as one
  // assertion naming the expected text. Classifying that would report CAUGHT for a
  // run whose real assertions say otherwise.
  // Written ONCE and used TWICE: for the tree the sweep runs over, and for the
  // control below. Two copies of these writes drift, and a drifted control attests
  // to a fixture that is no longer the one under test.
  const FORGING_TEST =
    `import { writeSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `if (guard) { console.log("PASS  the guard holds"); process.exitCode = 0; }\n` +
    `else {\n` +
    // Synchronous fd writes, PAUSED between them. Without the pauses the two stdout
    // writes coalesce into one data event before stderr's arrives, no interleaving
    // reaches the parent, and the fixture cannot exhibit the defect it exists for —
    // which is exactly what the first version did, passing under a stub of the fix.
    `  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);\n` +
    `  writeSync(1, "FAIL  wrong assertion"); pause();\n` +
    `  writeSync(2, " the guard holds\\n"); pause();\n` +
    `  writeSync(1, "\\n"); pause();\n` +
    `  process.exitCode = 1;\n}\n`;

  // CONTROL, and it is load-bearing rather than decorative. MEASURED on this
  // machine: when the forging does NOT happen the runner reports the same
  // WRONG_RED and exits 1, so BOTH assertions at the end of this block pass just
  // as green over a fixture that never exhibited the defect. Nothing in the
  // outcome separates the two cases, which is what made the pass meaningless
  // until the forging itself was established.
  {
    const c = tmpRoot("sweep-forge-control-");
    mkdirSync(join(c, "src")); mkdirSync(join(c, "test"));
    writeFileSync(join(c, "src", "thing.mjs"), `export const guard = false;\n`);
    writeFileSync(join(c, "test", "thing.test.mjs"), FORGING_TEST);
    // The merge has to be the RUNNER's merge: two async data handlers appending to
    // one buffer in arrival order. spawnSync hands back the streams already
    // separated and can never show an interleave, so a probe built on it would
    // answer a different question and report NOT_FORGED however the writes landed.
    writeFileSync(join(c, "probe.mjs"),
      `import { spawn } from "node:child_process";\n` +
      `const ch = spawn(process.execPath, ["test/thing.test.mjs"], { stdio: ["ignore", "pipe", "pipe"] });\n` +
      `let merged = "";\n` +
      `ch.stdout.on("data", b => { merged += b; });\n` +
      `ch.stderr.on("data", b => { merged += b; });\n` +
      // No process.exit: it does not flush a pending write, and a probe whose
      // verdict never arrives reads exactly like a probe that said NOT_FORGED.
      `ch.on("close", () => { process.stdout.write(\n` +
      `  merged.split("\\n").includes("FAIL  wrong assertion the guard holds") ? "FORGED\\n" : "NOT_FORGED\\n"); });\n`);
    const p = spawnSync(process.execPath, ["probe.mjs"], { cwd: c, encoding: "utf8" });
    check(/^FORGED$/m.test(p.stdout ?? ""),
      "control: the fixture really does forge a line neither stream emitted",
      `probe said ${JSON.stringify((p.stdout ?? "").trim())}; NOT_FORGED means the writes stopped ` +
      `interleaving and the two assertions below prove nothing, whatever they report`);
  }

  const root = tmpRoot("sweep-forge-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"), FORGING_TEST);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 1,
    "an assertion forged by interleaving does not pass the sweep", `exit=${r.status}\n        ${out.slice(-300)}`);
  check(!/CAUGHT/.test(out.split("\n")[0] ?? ""),
    "and the entry is not reported CAUGHT on a line neither stream emitted", out.slice(0, 200));
}

// --- an OVERWRITTEN ignored artifact is still a side effect ---------------------
{
  // A path list cannot see a control run overwriting an ignored file that already
  // existed: all readings carry the same `!! path`, so the stub is applied to
  // altered state and can read CAUGHT for a run that would not have been caught
  // from the untouched tree.
  const root = tmpRoot("sweep-overwrite-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, ".gitignore"), "*.cache\n");
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  // The artifact EXISTS before the sweep starts, so its path is in every reading.
  writeFileSync(join(root, "src", "build.cache"), "original\n");
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    // The CONTROL run rewrites its CONTENTS. The path never changes.
    `if (guard) writeFileSync(new URL("../src/build.cache", import.meta.url).pathname, "rewritten\\n");\n` +
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  check(execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd: root, encoding: "utf8" })
          .includes("build.cache"),
    "control: the artifact is ignored and present in every reading, which is the whole problem");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 1, "an ignored artifact the control OVERWROTE voids the reading", `exit=${r.status}`);
  check(/UNRUNNABLE/.test(out), "and it is reported UNRUNNABLE", out.slice(-320));
}

// --- the named assertion survives a budget filled by other failures -------------
{
  // Twenty thousand unrelated failures before the named one would otherwise fill
  // the retention budget, and the raw tail would scroll past it — so the entry
  // reads WRONG_RED for a stub the named assertion did catch.
  const root = tmpRoot("sweep-crowd-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { guard } from "../src/thing.mjs";\n` +
    `if (!guard) { for (let i = 0; i < 21000; i++) console.log("FAIL  unrelated failure " + i); }\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    `if (!guard) { const noise = "x".repeat(64 * 1024); for (let i = 0; i < 40; i++) console.log(noise); }\n` +
    `process.exitCode = guard ? 0 : 1;\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8", maxBuffer: 1 << 28,
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 0,
    // "COUNTED", not "kept". What makes this true is no longer that the line
    // survives retention -- it is that the failure was counted as it arrived. The
    // old wording described the mechanism that USED to carry it, and an assertion
    // whose name describes the wrong mechanism sends the next reader to the wrong
    // code when it breaks.
    "the named assertion is counted even when 21,000 other failures fill the budget",
    `exit=${r.status}\n        ${out.slice(-300)}`);
  check(/CAUGHT/.test(out), "and the verdict is CAUGHT rather than WRONG_RED", out.slice(-260));
}

// --- a target DELETED during a run is not resurrected ---------------------------
{
  // `sha` throws ENOENT on a file the test removed, the exception handler runs the
  // emergency restore, and the snapshot recreates it — silently undoing a deletion
  // somebody meant. What we cannot recognise as our own stub is not ours to replace.
  const root = tmpRoot("sweep-del-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { rmSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `console.log(guard ? "PASS  the guard holds" : "FAIL  the guard holds");\n` +
    // Deletes its own source mid-run, which is the hostile version of a person
    // removing a file in the same window.
    `rmSync(new URL("../src/thing.mjs", import.meta.url).pathname);\n` +
    `process.exit(guard ? 0 : 1);\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  check(!existsSync(join(root, "src", "thing.mjs")),
    "a target deleted during the run stays deleted, rather than being resurrected from the snapshot",
    `${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-300));
  check(r.status !== 0, "and the sweep does not report success over a tree it could not restore", String(r.status));
}

// --- a partly applied stub restores the files it DID write ----------------------
{
  // With two files and a bad anchor in the second, the first was already written
  // when the apply threw. `stubbedHashes` was never populated, so every file
  // compared as meddled and the written one was left stubbed with the tree dirty.
  const root = tmpRoot("sweep-partial-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  const A = `export const a = 1;\n`;
  writeFileSync(join(root, "src", "a.mjs"), A);
  writeFileSync(join(root, "src", "b.mjs"), `export const b = 2;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `console.log("PASS  the guard holds");\nprocess.exit(0);\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "two", why: "two files, second anchor rotted", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/a.mjs", find: "export const a = 1;", replace: "export const a = 99;" },\n` +
    `          { file: "src/b.mjs", find: "this anchor does not exist", replace: "x" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  check(readFileSync(join(root, "src", "a.mjs"), "utf8") === A,
    "the file that WAS written is restored when a later edit's anchor fails",
    readFileSync(join(root, "src", "a.mjs"), "utf8"));
  check(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
    "and the tree is left clean");
  check(r.status === 1, "while the entry itself fails the sweep", String(r.status));
}

// --- an ignored path git C-QUOTES is still fingerprinted ------------------------
{
  // Porcelain v1 quotes any path holding a space, a quote, a backslash or a
  // non-ASCII byte. Reading the quoted form as a filesystem path makes the stat
  // fail, so the entry fingerprints `<unreadable>` in EVERY reading and a control
  // run that OVERWRITES it changes nothing the sweep can see -- which is the exact
  // hole fingerprinting was added to close, reopened for any awkward name.
  const root = tmpRoot("sweep-quoted-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  // The control run OVERWRITES an artifact that already exists, so the path set is
  // identical across readings and only the content differs.
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { writeFileSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `writeFileSync(new URL("../my cache.tmp", import.meta.url), guard ? "control" : "stubbed");\n` +
    `if (guard) { console.log("PASS  the guard holds"); process.exitCode = 0; }\n` +
    `else { console.log("FAIL  the guard holds"); process.exitCode = 1; }\n`);
  writeFileSync(join(root, ".gitignore"), "my cache.tmp\n");
  writeFileSync(join(root, "my cache.tmp"), "pre-existing");
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  // CONTROL: the name must actually be one git quotes, or this fixture is testing
  // the ordinary path and would pass with the parser unchanged.
  const porcelain = git("status", "--porcelain", "--ignored");
  check(/!! "my cache\.tmp"/.test(porcelain),
    "control: git really does C-quote this ignored name in the human-readable form",
    JSON.stringify(porcelain));

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 1, "an ignored artifact with a QUOTED name still voids the reading",
    `exit=${r.status}\n        ${out.slice(-300)}`);
  check(/ignored/i.test(out), "and says the ignored artifact is why", out.slice(-260));
}

// --- an ignored SYMLINK is fingerprinted by its target text, not followed --------
{
  // `stat` follows the link, so an ignored symlink pointing at a fifo or a
  // character device would be READ -- and a read of `/dev/random` does not return.
  // Hashing the link TEXT detects retargeting without ever opening what it names.
  // The two targets hold IDENTICAL CONTENT and differ only in PATH. Following the
  // link and hashing what it points at therefore reads the same bytes before and
  // after the control run retargets it, and the retarget is invisible; hashing the
  // link TEXT sees it. That is what makes this fixture discriminating rather than
  // merely green -- content-hashing cannot pass it.
  const root = tmpRoot("sweep-link-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "a.bin"), "identical");
  writeFileSync(join(root, "src", "b.bin"), "identical");
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { symlinkSync, unlinkSync } from "node:fs";\n` +
    `import { fileURLToPath } from "node:url";\n` +
    `import { join, dirname } from "node:path";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `const root = dirname(dirname(fileURLToPath(import.meta.url)));\n` +
    `unlinkSync(join(root, "link.tmp"));\n` +
    `symlinkSync(join(root, "src", guard ? "b.bin" : "a.bin"), join(root, "link.tmp"));\n` +
    `if (guard) { console.log("PASS  the guard holds"); process.exitCode = 0; }\n` +
    `else { console.log("FAIL  the guard holds"); process.exitCode = 1; }\n`);
  writeFileSync(join(root, ".gitignore"), "link.tmp\n");
  execFileSync("ln", ["-s", join(root, "src", "a.bin"), join(root, "link.tmp")]);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");
  // CONTROL: the two targets really are byte-identical, so a content hash cannot
  // tell them apart and only the link text can.
  check(readFileSync(join(root, "src", "a.bin"), "utf8") === readFileSync(join(root, "src", "b.bin"), "utf8"),
    "control: the symlink's two targets are byte-identical");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 1, "an ignored symlink RETARGETED by the control run voids the reading",
    `exit=${r.status}\n        ${out.slice(-300)}`);
  void createHash;
}

// --- a PASS naming the expected text does not spend the reservation --------------
{
  // `ASSERTION` matches PASS as well as FAIL. A passing assertion whose name
  // contains the expected text used to set `namedKept`, spending the slot reserved
  // for the FAIL; unrelated failures then filled the budget and the real named
  // failure scrolled out, so the entry read WRONG_RED for a stub it had caught.
  const root = tmpRoot("sweep-passfirst-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { guard } from "../src/thing.mjs";\n` +
    `if (guard) { console.log("PASS  the guard holds"); process.exitCode = 0; }\n` +
    `else {\n` +
    // A PASS naming the expected text FIRST, then enough unrelated failures to
    // exhaust the retention budget, then the real named failure LAST.
    `  console.log("PASS  the guard holds under load");\n` +
    `  for (let i = 0; i < 21000; i++) console.log("FAIL  unrelated " + i);\n` +
    `  console.log("FAIL  the guard holds");\n` +
    `  process.exitCode = 1;\n}\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 0 && /CAUGHT/.test(out),
    "a PASS naming the expected text does not crowd out the named FAIL",
    `exit=${r.status}\n        ${out.slice(0, 300)}`);
}

// --- the named FAIL arriving LAST and unterminated is still counted --------------
{
  // The close-time tails were handled by a second copy of the rules that carried
  // the budget but not the named reservation, so an expected FAIL written without a
  // trailing newline, after earlier failures had filled the budget, was discarded.
  // The raw body is deliberately inert, so nothing else could see it either.
  const root = tmpRoot("sweep-tail-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { writeSync } from "node:fs";\n` +
    `import { guard } from "../src/thing.mjs";\n` +
    `if (guard) { console.log("PASS  the guard holds"); process.exitCode = 0; }\n` +
    `else {\n` +
    `  for (let i = 0; i < 21000; i++) console.log("FAIL  unrelated " + i);\n` +
    // NO trailing newline: this line only ever exists in `partial` and reaches the
    // classifier through the close handler or not at all.
    `  writeSync(1, "FAIL  the guard holds");\n` +
    `  process.exitCode = 1;\n}\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(r.status === 0 && /CAUGHT/.test(out),
    "an unterminated named FAIL after the budget fills is still counted",
    `exit=${r.status}\n        ${out.slice(0, 300)}`);
}

// --- a run reporting only PASSes is WRONG_RED, not CRASHED -----------------------
{
  // Only FAIL lines are retained, and the raw body is inert, so a run that printed
  // passing assertions and then exited non-zero had nothing retained to prove an
  // assertion had run at all. Asking the retention buffer that question answered a
  // question about RETENTION and called a run that reported results a crash.
  check(classify({ controlExit: 0, stubExit: 1, hashChanged: true, restored: true,
                   expectRed: "the guard holds",
                   observed: { anyAssertionSeen: true, namedFailSeen: false, failures: [] } }).verdict === WRONG_RED,
    "a stubbed run reporting only PASSes is WRONG_RED rather than CRASHED");
  check(classify({ controlExit: 0, stubExit: 1, hashChanged: true, restored: true,
                   expectRed: "the guard holds",
                   observed: { anyAssertionSeen: false, namedFailSeen: false, failures: [] } }).verdict === CRASHED,
    "control: a run reporting NOTHING is still CRASHED, so the two are not merged");
}

// --- only-passes, END TO END, is the one case the counters alone can decide ------
{
  // The direct `classify` case above proves the ternary. It cannot prove the RUNNER
  // ever supplies counters, because it passes its own -- and that gap shipped: the
  // counting path was computed for every line and never put on the resolved run, so
  // the classifier silently fell back to text and nothing failed.
  //
  // This is the fixture where the two paths DISAGREE end to end. No FAIL line is
  // ever printed, so nothing is retained and the raw body is inert: reading the text
  // finds no assertion at all and calls the run CRASHED, while the counters know a
  // PASS was reported and call it WRONG_RED. Every other fixture here agrees under
  // both paths, which is exactly why they all stayed green while the seam was dead.
  const root = tmpRoot("sweep-onlypass-");
  mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
  writeFileSync(join(root, "src", "thing.mjs"), `export const guard = true;\n`);
  writeFileSync(join(root, "test", "thing.test.mjs"),
    `import { guard } from "../src/thing.mjs";\n` +
    `if (guard) { console.log("PASS  the guard holds"); process.exitCode = 0; }\n` +
    `else { console.log("PASS  something unrelated passed"); process.exitCode = 1; }\n`);
  writeFileSync(join(root, "test", "stub-manifest.mjs"),
    `export const STUBS = [{ name: "g", why: "flip the guard", test: "test/thing.test.mjs",\n` +
    `  expectRed: "the guard holds",\n` +
    `  edits: [{ file: "src/thing.mjs", find: "export const guard = true;", replace: "export const guard = false;" }] }];\n`);
  const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "s@e.invalid"); git("config", "user.name", "s");
  git("add", "-A"); git("commit", "-q", "-m", "fixture");

  const r = spawnSync(process.execPath, [RUNNER], { cwd: root, encoding: "utf8",
    env: { ...process.env, STUB_SWEEP_ROOT: root, STUB_MANIFEST: join(root, "test", "stub-manifest.mjs") } });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  check(/WRONG_RED/.test(out) && !/CRASHED/.test(out),
    "the runner's own counters reach the verdict: only-passes is WRONG_RED, not CRASHED",
    out.slice(0, 400));
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
