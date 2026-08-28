/**
 * The reasoning behind the stub sweep, with no filesystem and no subprocess.
 *
 * A test that passes proves the code passes the test. It does not prove the test
 * could ever have failed, and those are different claims. The way to tell them
 * apart is to break the code deliberately and check the test notices — and this
 * repository paid for that three times in one pull request, each time with a green
 * assertion that was plausible and worthless:
 *
 *   · a count asserted in a case where the right and the wrong readings are both 0;
 *   · a deadline bound that was correct inside the callee while the CALLER never
 *     passed a deadline, so every test of the mechanism passed with the wiring gone;
 *   · a guard whose fixture filtered the row out before the guarded line ran.
 *
 * All three were caught by stubbing the fix back out and reading the EXIT CODE.
 * None was caught by writing the test, by reading it back, or by review.
 *
 * So the sweep stops being a habit and becomes an artefact. The point is not
 * automation: it is that "I added a guard" and "I proved the guard is reached"
 * become ONE action rather than two, the second of which is currently optional.
 *
 * Several rules below come from a second session's sweeps rather than this one's,
 * and are marked where they do. They were measured there, not reasoned here.
 */

/** The named assertion failed. The only outcome that proves anything. */
export const CAUGHT = "CAUGHT";
/** The suite stayed green with the defect back in: the property is untested. */
export const NOT_CAUGHT = "NOT_CAUGHT";
/** Something failed, but not the assertion this stub is about. */
export const WRONG_RED = "WRONG_RED";
/** The test did not fail an assertion, it died. A crash is not a passing sweep. */
export const CRASHED = "CRASHED";
/** The sweep could not take a reading, which is never a pass. */
export const UNRUNNABLE = "UNRUNNABLE";

/**
 * Apply one edit, or refuse.
 *
 * An anchor matching zero times is a manifest that has rotted against the code it
 * describes; an anchor matching more than once is an edit whose effect depends on
 * which copy it hit. Both refuse rather than substituting best-effort, because a
 * half-applied stub produces a reading about a tree nobody intended, and that
 * reading is indistinguishable from a real one.
 *
 * Applied IN PROCESS on strings. A neighbouring session built its first harness by
 * interpolating replacements into a `python3 -c` string and read two shell-quoting
 * accidents as findings; a runner must not be able to manufacture a false reading
 * of its own.
 */
export function applyEdit(source, { find, replace }) {
  const n = countOccurrences(source, find);
  if (n !== 1)
    throw new Error(
      `anchor appears ${n} time(s), refusing to apply: ${JSON.stringify(find.slice(0, 80))}` +
      (n === 0 ? `\n${describeMiss(source, find)}` : ""));
  return source.replace(find, replace);
}

/**
 * Where an anchor stopped matching, and what the file says there instead.
 *
 * A manifest rots against refactors — that is not a flaw in it, it is the cost of
 * pinning to source. The refusal is correct either way; this is about whether the
 * next person spends a minute or an hour. Same reasoning as the merge verifier
 * printing a SCOPE line on a clean verdict: a tool that says precisely what it
 * could not do is worth more than one that only says no. Suggested by the session
 * that wrote that verifier.
 *
 * The longest matching PREFIX is the divergence point, so the file's text there is
 * almost always the edit that moved the anchor.
 */
export function describeMiss(source, find) {
  let lo = 0, hi = find.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (source.includes(find.slice(0, mid))) lo = mid; else hi = mid - 1;
  }
  if (lo === 0) return "  no part of the anchor appears in the file; it may name the wrong file entirely";
  const at = source.indexOf(find.slice(0, lo));
  const line = source.slice(0, at).split("\n").length;
  const shown = source.slice(at, at + lo + 60).split("\n").slice(0, 4).join("\n");
  return `  matched the first ${lo} character(s) at line ${line}, then diverged.\n` +
         `  the file there now reads:\n` +
         shown.split("\n").map(l => `    | ${l}`).join("\n") + "\n" +
         `  the anchor expected:\n` +
         find.slice(0, lo + 60).split("\n").slice(0, 4).map(l => `    | ${l}`).join("\n");
}

/** Literal, not regex. A stub anchor is a chunk of source, not a pattern. */
function countOccurrences(haystack, needle) {
  if (!needle) throw new Error("an empty anchor matches everywhere; refusing");
  let n = 0, i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) return n;
    n++;
    i = at + needle.length;
  }
}

/**
 * Reject a manifest that cannot produce a meaningful reading.
 *
 * Checked before anything is written, so a malformed entry cannot leave the tree
 * stubbed. Every rule corresponds to a way an ad-hoc sweep got it wrong.
 */
export function validateManifest(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("the manifest is empty; a sweep with no stubs reports success having measured nothing");
  const seen = new Set();
  for (const [i, e] of entries.entries()) {
    const where = `entry ${i}${e?.name ? ` (${e.name})` : ""}`;
    if (!e?.name) throw new Error(`${where}: needs a name`);
    if (seen.has(e.name)) throw new Error(`${where}: duplicate name`);
    seen.add(e.name);
    // In the manifest rather than in a commit message, because the next person to
    // see this red needs to know what it is asking. An unexplained stub gets
    // deleted the first time it is inconvenient.
    if (!e.why) throw new Error(`${where}: needs a "why" — what defect this stub reintroduces`);
    if (!e.test) throw new Error(`${where}: needs the test file to run`);
    // THE ASSERTION, not just the file. A file-level expectation is satisfied by
    // ANY failure in that file, so a stub that breaks something adjacent reads as
    // success while the property it was aimed at stays unmeasured. Measured by a
    // neighbouring session, which hit exactly that.
    if (!e.expectRed)
      throw new Error(`${where}: needs "expectRed" — text from the assertion that must fail, not just a file`);
    if (!Array.isArray(e.edits) || e.edits.length === 0)
      throw new Error(`${where}: needs at least one edit`);
    for (const [j, ed] of e.edits.entries()) {
      if (!ed?.file) throw new Error(`${where}: edit ${j} needs a file`);
      if (typeof ed.find !== "string" || !ed.find)
        throw new Error(`${where}: edit ${j} needs a non-empty anchor`);
      if (typeof ed.replace !== "string")
        throw new Error(`${where}: edit ${j} needs a replacement (use "" to delete)`);
      if (ed.find === ed.replace)
        throw new Error(`${where}: edit ${j} replaces the anchor with itself, so it changes nothing`);
    }
  }
  return entries;
}

/**
 * Which assertions a run reported as failing.
 *
 * Tied to this repository's own test output — `PASS  name` / `FAIL  name` — rather
 * than to a framework, because that is what these tests emit.
 */
export function failedAssertions(output) {
  return String(output).split("\n")
    .filter(l => l.startsWith("FAIL"))
    .map(l => l.slice(4).trim());
}

/** Whether the run produced any assertion results at all. */
export function reportedAnyAssertion(output) {
  return String(output).split("\n").some(l => l.startsWith("PASS") || l.startsWith("FAIL"));
}

/**
 * What one entry's readings mean.
 *
 * `controlExit` is the named test BEFORE stubbing, checked per entry rather than
 * once: an earlier entry that failed to restore would otherwise be measured as
 * this entry's result.
 *
 * `hashChanged` is how we know the stub actually landed. Re-grepping to confirm it
 * was measured inert three times in a neighbouring session — a red after a stub
 * that never applied means nothing, and a green means less.
 *
 * The asymmetry is the design. A stub that fails the NAMED assertion tells us the
 * test can fail for that reason. Anything else tells us it cannot, and that is a
 * failure of the sweep rather than a pass.
 */
export function classify({ controlExit, stubExit, stubOutput = "", hashChanged, restored, expectRed }) {
  if (controlExit !== 0)
    return { verdict: UNRUNNABLE,
             why: `the test does not pass before stubbing (exit ${controlExit}), so nothing it reports afterwards means anything` };
  if (!hashChanged)
    return { verdict: UNRUNNABLE,
             why: "the file's hash did not change, so the stub never landed and this reading is about the unmodified tree" };
  if (!restored)
    return { verdict: UNRUNNABLE,
             why: "the tree did not restore to its original bytes, so every later reading would measure the stub" };

  if (stubExit === 0)
    // TWO causes, and they need different repairs. Either no assertion covers the
    // property, or one does and its FIXTURE cannot exhibit the defect — a
    // neighbouring session had a correctly-named assertion whose repo value could
    // never trigger the bug it was written for. Naming both is the difference
    // between rewriting a test and rewriting its inputs.
    return { verdict: NOT_CAUGHT,
             why: "the suite stayed green with the defect reintroduced. Either nothing asserts this property, " +
                  "or something does and its fixture cannot reach the mechanism — check the fixture before the assertion" };

  const failures = failedAssertions(stubOutput);
  if (!reportedAnyAssertion(stubOutput))
    return { verdict: CRASHED,
             why: `the test exited ${stubExit} without reporting a single assertion, so it died rather than failed; ` +
                  "a runner reading only the exit code would have called this a pass" };
  if (!failures.some(f => f.includes(expectRed)))
    return { verdict: WRONG_RED,
             why: `something failed, but not the named assertion — the property is still unmeasured. Failed: ` +
                  failures.map(f => JSON.stringify(f)).join(", ") };

  return { verdict: CAUGHT, why: `the named assertion failed, as it should` };
}

/**
 * The sweep's own verdict. Anything not CAUGHT fails it.
 *
 * No partial credit and no warning level. A NOT_CAUGHT entry is a test that
 * reports success regardless of the code, which is precisely the failure this
 * exists to find; letting it warn would make it a line of output someone
 * eventually stops reading.
 */
export function summarise(results) {
  const bad = results.filter(r => r.verdict !== CAUGHT);
  return {
    ok: bad.length === 0 && results.length > 0,
    total: results.length,
    caught: results.filter(r => r.verdict === CAUGHT).length,
    problems: bad,
  };
}
