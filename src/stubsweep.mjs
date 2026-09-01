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
import { createHash } from "node:crypto";
import { join } from "node:path";
import { lstatSync, readlinkSync, openSync, readSync, closeSync, fstatSync, constants } from "node:fs";

// At the TOP: this is read by a guard, and a guard goes in early while its constant
// goes in late, which is how both temporal-dead-zone bugs in this lineage happened.
const HASH_CHUNK = 1 << 20;

export const CAUGHT = "CAUGHT";
/** The suite stayed green with the defect back in: the property is untested. */
export const NOT_CAUGHT = "NOT_CAUGHT";
/** Something failed, but not the assertion this stub is about. */
export const WRONG_RED = "WRONG_RED";
/** The test did not fail an assertion, it died. A crash is not a passing sweep. */
export const CRASHED = "CRASHED";
/** The sweep could not take a reading, which is never a pass. */
export const UNRUNNABLE = "UNRUNNABLE";
/** What the runner reports for a child it had to kill. Not a failing assertion. */
export const TIMED_OUT_EXIT = 124;

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
  const fileLine = source.slice(0, at).split("\n").length;
  // WHERE IN THE ANCHOR, not only how many characters. A short prefix reads as
  // "this line changed near its start" when it is very often "this block moved and
  // only its first line still matches" — two situations with different repairs.
  // Reporting the anchor's own line makes the difference visible: diverging at
  // line 1 of 6 is a move, diverging at line 5 of 6 is an edit. Suggested by the
  // session that raised the case.
  // A trailing newline is a TERMINATOR, not another line. `"a\nb\n"` is two lines;
  // splitting it yields three segments because the last is the empty string after
  // the final terminator. The inflated count also pushed anchors over the
  // `anchorLines > 2` threshold and enabled a move hint the heuristic excludes.
  const anchorLines = find.replace(/\n$/, "").split("\n").length;
  // COMPLETE lines, counted by newlines rather than by segments. A prefix that
  // matched line 1 and the first two characters of line 2 splits into two
  // segments, so a naive count calls that "two lines matched" when one did — and
  // the move heuristic below then never fires for the case it exists for.
  const completeLinesMatched = (find.slice(0, lo).match(/\n/g) ?? []).length;
  const divergedAtAnchorLine = completeLinesMatched + 1;
  const shown = source.slice(at, at + lo + 60).split("\n").slice(0, 4).join("\n");
  // EXACTLY ONE completed line. Zero means the divergence is inside the first
  // line — an edit — and calling that a probable move collapses the two cases this
  // hint exists to separate.
  const shape = anchorLines > 2 && completeLinesMatched === 1
    ? "  only the anchor's FIRST line still matches, which usually means the block moved rather than changed\n"
    : "";
  return `  matched the first ${lo} character(s) — anchor line ${divergedAtAnchorLine} of ${anchorLines} — at file line ${fileLine}, then diverged.\n` +
         shape +
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
    // ADVANCE BY ONE, not by the needle's length. Skipping ahead by the whole
    // match misses OVERLAPPING occurrences: `countOccurrences("aaa", "aa")`
    // returns 1, so `applyEdit` accepts an anchor that appears at two offsets and
    // silently edits the first — the precise ambiguity the count exists to refuse.
    i = at + 1;
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
    // A NON-EMPTY STRING, checked rather than merely truthy. `String.prototype
    // .includes` coerces its argument, so `expectRed: []` becomes the empty string
    // and matches EVERY failing assertion — the entry then reports CAUGHT whatever
    // went red, which is exactly the named-assertion invariant this field exists
    // to hold.
    if (typeof e.expectRed !== "string" || !e.expectRed.trim())
      throw new Error(`${where}: "expectRed" must be a non-empty string — text from the assertion that must fail, not just a file`);
    if (!Array.isArray(e.edits) || e.edits.length === 0)
      throw new Error(`${where}: needs at least one edit`);
    for (const [j, ed] of e.edits.entries()) {
      // A STRING, by type. A truthy non-string reaches `join` in the runner and
      // throws a raw TypeError before the uncaughtException handler is installed,
      // so the process dies with status 1 and a stack trace — indistinguishable
      // from a stub that was not caught, when it is really a malformed manifest.
      if (typeof ed?.file !== "string" || !ed.file.trim())
        throw new Error(`${where}: edit ${j} needs a non-empty string "file"`);
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
const ASSERTION = /^(PASS|FAIL) {2}(.+)$/;

export function failedAssertions(output) {
  // THE DELIMITER IS PART OF THE PROTOCOL. Matching a bare `FAIL` prefix also
  // matches ordinary diagnostics — `FAILURE: named guard`, `FAILED 2` — and a
  // crashing test that prints one containing the expected text would be read as
  // the named assertion failing, so a run where no assertion executed at all
  // would report CAUGHT.
  return String(output).split("\n")
    .map(l => ASSERTION.exec(l))
    .filter(m => m && m[1] === "FAIL")
    .map(m => m[2].trim());
}

/** Whether the run produced any assertion results at all. */
export function reportedAnyAssertion(output) {
  return String(output).split("\n").some(l => ASSERTION.test(l));
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
/**
 * `observed` is the VERDICT's evidence; `stubOutput` is only the human's.
 *
 * Three separate defects came from deriving the verdict by re-reading a retained
 * buffer: a PASS line naming the expected text consumed the reservation meant for
 * the FAIL, an unterminated final FAIL after budget exhaustion was discarded, and a
 * run reporting only PASSes was called CRASHED because nothing retained proved an
 * assertion had run. All three are the same defect -- a buffer that EVICTS decided
 * the verdict -- so the verdict no longer reads the buffer at all.
 *
 * The caller counts what it sees as each line arrives, where every line passes
 * exactly once and nothing can be evicted. When `observed` is absent the old text
 * parsing still applies, because a caller holding only output is answering a
 * weaker question and should not be forced to lie about having counted.
 */
export function classify({ controlExit, stubExit, stubOutput = "", hashChanged, restored, expectRed,
                           observed = null, controlObserved = null }) {
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

  // A TIMEOUT IS NOT A RED. `spawnSync` reports a killed child with a null status,
  // which the runner maps to 124 — and a test that printed the expected FAIL line
  // and then hung would otherwise be read as CAUGHT, because the output matches and
  // the exit is non-zero. The run never finished, so what it would have reported is
  // unknown; an incomplete reading is not evidence.
  if (stubExit === TIMED_OUT_EXIT)
    return { verdict: UNRUNNABLE,
             why: "the test was killed for exceeding its time limit, so the run never completed — " +
                  "whatever it printed first is not a verdict" };

  const failures = observed ? observed.failures : failedAssertions(stubOutput);
  // COUNTED AT INGESTION when the caller counted. A PASS line is an assertion
  // result even though no PASS line is ever retained, so asking the buffer whether
  // an assertion ran answers a question about RETENTION and reports the run as a
  // crash on the strength of it.
  const seen = observed ? observed.assertionsSeen : (reportedAnyAssertion(stubOutput) ? 1 : 0);
  const namedFailed = observed
    ? observed.namedFailSeen
    : failures.some(f => f.includes(expectRed));
  if (seen === 0)
    return { verdict: CRASHED,
             why: `the test exited ${stubExit} without reporting a single assertion, so it died rather than failed; ` +
                  "a runner reading only the exit code would have called this a pass" };
  // A SHORTER RUN THAN THE CONTROL IS NOT A READING.
  //
  // The TIMED_OUT branch above already refuses a run that did not finish, on the
  // grounds that an incomplete reading is not evidence. A file that ABORTS is the
  // same fact arriving through a different exit, and it was not refused: the
  // named assertion had usually already gone red before the abort, so every other
  // signal said CAUGHT while the assertions after the abort never ran -- and in a
  // log an assertion that never ran is indistinguishable from one that passed.
  //
  // The comparison is against the CONTROL's count, not a constant. Nothing here
  // knows how many assertions a file should have, and a threshold would be a
  // tuned number that stops describing the file the moment it grows. The control
  // establishes the number for this file, on this tree, minutes earlier.
  //
  // STRICTLY FEWER, with no tolerance. A stub makes an assertion fail; it does
  // not make one disappear, because a failing `check` returns rather than throws.
  // If the count drops, execution left the path the control took, and what the
  // remaining assertions would have said is unknown. A stub that legitimately
  // shortens its file cannot be compared against its control at all, which is a
  // reason to rewrite the entry rather than to widen the rule.
  if (controlObserved && seen < controlObserved.assertionsSeen)
    return { verdict: UNRUNNABLE,
             why: `the stubbed run reported ${seen} assertion(s) where the control reported ` +
                  `${controlObserved.assertionsSeen}, so the file stopped early and the ` +
                  `${controlObserved.assertionsSeen - seen} it did not reach are unmeasured — ` +
                  "an assertion that never ran reads exactly like one that passed" };
  if (!namedFailed)
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

/**
 * Porcelain `-z` into `{xy, path, line}`, which the human-readable form cannot give.
 *
 * A rename or copy carries its SOURCE as the NEXT NUL field rather than on the same
 * one. Consuming it here stops it being read as an entry in its own right, which
 * would put a path into `tracked` that git never reported as a change and refuse a
 * clean tree.
 */
export function parsePorcelainZ(raw) {
  // BYTES, never a decoded string. `-z` emits filenames verbatim, and decoding as
  // UTF-8 replaces every undecodable byte with U+FFFD -- so a POSIX name that is not
  // valid UTF-8 becomes a path that does not exist, fingerprints `<unreadable>` in
  // every reading, and a control run can overwrite the real file invisibly. That is
  // the SAME outcome as the C-quoting defect this parser was written to fix, one
  // layer further down: the first fix stopped git from mangling the name and this
  // one stops us from mangling it ourselves.
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "binary");
  const fields = [];
  let start = 0;
  for (let i = 0; i <= buf.length; i++) {
    if (i === buf.length || buf[i] === 0) { if (i > start) fields.push(buf.subarray(start, i)); start = i + 1; }
  }
  const out = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    // The status letters are ASCII by the format's own definition, so decoding those
    // two bytes is safe; the PATH after them is kept as bytes.
    const xy = f.subarray(0, 2).toString("latin1");
    const path = f.subarray(3);
    if (xy[0] === "R" || xy[0] === "C") i++;
    out.push({ xy, path, line: `${xy} ${displayPath(path)}` });
  }
  return out;
}

/**
 * A path for HUMANS and for comparison, which must stay injective over bytes.
 *
 * Two different names that both decode to the same replacement characters would
 * otherwise compare equal, and the reading would not notice one being swapped for
 * the other. Cleanly decodable names print as themselves; anything else carries a
 * hash of its actual bytes, so the comparison distinguishes them even though the
 * printed form cannot.
 */
export function displayPath(pathBuf) {
  // TWO DISJOINT NAMESPACES, because the previous form was not injective and said it
  // was. It returned `<decoded> <bytes HASH>` for an undecodable name -- and a
  // perfectly valid filename can BE that text, so a control run could swap one for
  // the other and both the line and the fingerprint would match.
  //
  // `u:` carries a name that survives a UTF-8 round trip, `x:` carries the raw bytes
  // in hex. Two different byte sequences cannot collide: both decodable means the
  // decoded strings differ, both undecodable means the hex differs, and one of each
  // differs in the prefix. Readability survives for the ordinary case, which is every
  // case anyone will actually look at.
  const s = pathBuf.toString("utf8");
  return Buffer.from(s, "utf8").equals(pathBuf) ? `u:${s}` : `x:${pathBuf.toString("hex")}`;
}

/**
 * One ignored entry's fingerprint, without ever reading a file whole and without
 * ever following a link.
 *
 * `lstat`, not `stat`: an ignored SYMLINK to a fifo or a character device would
 * otherwise be opened and read, and a read of `/dev/random` does not return. The
 * link's TARGET is hashed instead, so retargeting it is still detected while
 * whatever it points at is never touched.
 *
 * Regular files are hashed in fixed chunks. This repository ignores `*.db`,
 * `*.db-wal` and `*.db-shm`, and reeve's own state databases are exactly that, so
 * reading one whole into a Buffer costs its full size -- three readings per entry,
 * on every entry in the manifest.
 */
export function fingerprint(abs) {
  let st;
  try { st = lstatSync(abs); } catch { return "<unreadable>"; }
  if (st.isSymbolicLink()) {
    try {
      return `<symlink> ${createHash("sha256").update(readlinkSync(abs)).digest("hex").slice(0, 16)}`;
    } catch { return "<symlink, unreadable>"; }
  }
  // DIRECTORIES are not walked: `--ignored` collapses `node_modules` to one line,
  // and walking it would cost more than the whole sweep. Stated, not hidden -- an
  // artifact created inside an already-ignored directory is not detected, and the
  // answer to that is to name the file in .gitignore rather than its parent.
  if (st.isDirectory()) return "<dir, not fingerprinted>";
  if (!st.isFile()) return "<not a regular file>";
  const h = createHash("sha256");
  let fd;
  // THE OPEN ITSELF MUST BE SAFE, because `lstat` describes the path a moment ago and
  // anything can replace it before the open. TWO different races, needing two flags:
  //
  //   O_NOFOLLOW  the file is replaced by a SYMLINK. Without it the open follows the
  //               link and the read is redirected.
  //   O_NONBLOCK  the file is replaced by a FIFO, which is not a symlink, so
  //               O_NOFOLLOW does nothing. Opening a fifo read-only BLOCKS until a
  //               writer appears, so the descriptor never reaches the fstat below and
  //               the sweep hangs with the tree still stubbed. Non-blocking makes the
  //               open return so the check can happen at all. It has no effect on a
  //               regular file's reads, which is the only case that gets that far.
  //
  // WINDOWS HAS NEITHER, and the earlier version of this comment claimed the fstat
  // covered that. It does not: fstat describes what the descriptor POINTS AT, never
  // how it was reached, so a symlink swapped in on Windows is followed and its
  // regular target hashed silently. What is portable is comparing the identity of the
  // file that was checked with the identity of the one that was opened -- a swap
  // changes it. Where the platform cannot supply a usable identity the answer is a
  // marker rather than a hash, because an unverifiable read is not evidence.
  const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
  const NONBLOCK = constants.O_NONBLOCK ?? 0;
  try { fd = openSync(abs, constants.O_RDONLY | NOFOLLOW | NONBLOCK); } catch { return "<unreadable>"; }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return "<not a regular file>";
    // The identity check, which is what stands in for O_NOFOLLOW where it is absent.
    // On a platform that reports no inode there is nothing to compare, and saying so
    // is better than hashing a file we cannot show is the one we checked.
    if (!NOFOLLOW) {
      if (!opened.ino || !st.ino) return "<unverifiable: no no-follow open on this platform>";
      if (opened.ino !== st.ino || opened.dev !== st.dev) return "<replaced during the read>";
    }
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    for (;;) {
      const n = readSync(fd, buf, 0, HASH_CHUNK, null);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
    }
  } catch { return "<unreadable>"; } finally { closeSync(fd); }
  return h.digest("hex").slice(0, 16);
}

/**
 * Which test files the manifest actually speaks for, and which are only tolerated.
 *
 * PURE, and separated from both readers on purpose. The gate in
 * `test/stubsweep.test.mjs` and the ratio line in `scripts/stub-sweep.mjs` are two
 * consumers of ONE fact. Computing it twice is how two numbers that must agree
 * begin disagreeing, and this repository has paid for that shape more than once.
 *
 * WHY A GATE EXISTS AT ALL. Measured 2026-08-30: 48 entries covering 3 of 106 test
 * files, and 26 of the 48 were on the sweep's own test. So the REQUIRED job whose
 * whole claim is "these tests can fail" was answering that for three percent of the
 * suite, and every file added since had quietly joined the untested majority.
 *
 * `covered` is a file some entry names. `grandfathered` is the frozen debt: files
 * that predate the rule and are tolerated until someone touches them. `orphans` are
 * neither, and an orphan is the failure -- a test file nobody has shown can fail,
 * and that nobody declared.
 */
export function coverage(entries, testFiles, grandfathered = [], proven = null) {
  const named = new Set((entries ?? []).map(e => e?.test).filter(Boolean));
  // FILES WITH A PROVEN GUARD, when the run can say. A file whose only entry is
  // UNRUNNABLE has no working guard, so counting it as covered overstates at the
  // FILE level exactly as counting the entry overstates at the entry level. Fixing
  // one and not the other left the more visible number still wrong.
  const provenNamed = proven === null
    ? null
    : new Set(proven.map(e => e?.test).filter(Boolean));
  const spared = new Set(grandfathered);
  const files = [...new Set(testFiles ?? [])].sort();
  const covered = files.filter(f => named.has(f));
  const orphans = files.filter(f => !named.has(f) && !spared.has(f));
  // A grandfathered file that has SINCE gained an entry, or that no longer exists.
  // Both mean the list is describing a tree that has moved on, and a list nobody is
  // required to correct is a list that silently becomes a blanket exemption.
  const stale = [...spared].filter(f => named.has(f) || !files.includes(f)).sort();
  return { files, covered, orphans, stale, spared: [...spared].sort(),
           entries: (entries ?? []).length,
           provenCovered: provenNamed === null ? null : files.filter(f => provenNamed.has(f)) };
}

/**
 * The debt, in one line, for whoever is looking at the output rather than the code.
 *
 * Printed on every run because the ratio was the thing nobody had seen. A number
 * that only exists inside a function cannot embarrass anyone into fixing it.
 */
export function coverageLine(c, proven = null) {
  // `proven` is how many entries actually RAN and were caught, when the run covered
  // the whole manifest. Counting entries alone overstates coverage by exactly the
  // thing this tool exists to prevent: an entry whose anchor no longer matches is
  // reported UNRUNNABLE and guards nothing, while still being counted as a guard.
  // That was not hypothetical -- one entry sat unrunnable on the default branch from
  // the moment a refactor moved the code its anchor named.
  const head = proven === null || proven === c.entries
    ? `${c.entries} entr${c.entries === 1 ? "y" : "ies"}`
    : `${c.entries} entr${c.entries === 1 ? "y" : "ies"} of which only ${proven} PROVEN`;
  // The FILE count follows the same rule. When the run knows which entries actually
  // ran, the files reported as covered are the ones with a proven guard, not the ones
  // merely named by an entry.
  const files = c.provenCovered == null || c.provenCovered.length === c.covered.length
    ? `${c.covered.length} of ${c.files.length} test file(s)`
    : `${c.provenCovered.length} of ${c.files.length} test file(s) PROVEN (${c.covered.length} named)`;
  return `${head} over ${files}; ${c.spared.length} grandfathered`;
}

/**
 * The files a change touches, or a REFUSAL saying why they could not be read.
 *
 * NEVER an empty list on failure, and that is the whole point. Both CI jobs check
 * out at depth 1, where there is no history and no merge base -- and a diff against
 * a base that cannot be resolved does not error, it yields NOTHING. An empty change
 * set intersects an empty grandfather list and the gate passes: green, fast, and
 * measuring nothing. That is the exact failure this gate exists to catch, arriving
 * through the checkout configuration rather than through the logic.
 *
 * So an unresolvable base is a REFUSAL, never a pass, for the same reason reeve
 * treats a cancelled check as uninformative rather than as success. The message
 * names the knob, because whoever hits it is looking at a red gate and a clean diff
 * with no obvious cause.
 */
export function changedFiles({ base, head, run }) {
  if (!base) return { ok: false, files: [], why:
    "the base commit could not be resolved, so which files changed is unknown; " +
    "this is a refusal rather than an empty diff because an empty diff would PASS. " +
    "In CI the sweep gate needs `fetch-depth: 0` on its checkout step" };
  const r = run(["diff", "--name-only", `${base}...${head}`]);
  if (!r || r.ok === false) return { ok: false, files: [], why:
    `the diff from ${base} to ${head} could not be read: ${r?.err ?? "no output"}` };
  return { ok: true, files: String(r.out ?? "").split("\n").filter(Boolean), why: null };
}

/**
 * Does this change touch a test file that is only tolerated while untouched?
 *
 * PURE, and separated from the runner deliberately. The runner skips this whole
 * mechanism when driven against a synthetic fixture, because a fixture repository has
 * no base to diff against -- which means the mechanism CANNOT be exercised through
 * that seam. An instrument that can only be wired and never shown to fire is the
 * exact shape the sweep exists to find, so the decision lives here where a test can
 * reach it without a repository at all.
 *
 * The refusal names each file and says what to do, because the person who trips this
 * is mid-edit on a file they did not know was on a list.
 */
export function grandfatherGate({ changed, grandfathered }) {
  const spared = new Set(grandfathered ?? []);
  const touched = (changed ?? []).filter(f => spared.has(f));
  if (!touched.length) return { ok: true, touched: [], why: null };
  return { ok: false, touched, why:
    "these test files are GRANDFATHERED and you are editing them:\n" +
    touched.map(f => `  ${f}`).join("\n") + "\n\n" +
    "Grandfathering covers files nobody touches. Add a manifest entry proving one of\n" +
    "each file's assertions can fail, then remove it from GRANDFATHERED in\n" +
    "test/stub-manifest.mjs." };
}

/**
 * Did the frozen list GROW, or did coverage shrink?
 *
 * PURE, and separate from the edit rule because they catch different moves. The edit
 * rule refuses touching a listed file. It says nothing about a change that removes a
 * test's STUBS entry and adds that test to the list instead: the file itself is never
 * edited, so the intersection sees only the manifest in the diff and passes, while
 * the list grows and measured coverage falls. The rule was described as a ratchet
 * from the start and only the edit half was built.
 *
 * Growth is the thing refused, not size. Removing names is how the debt is paid, so a
 * shorter list is the desired direction and passes silently.
 */
export function listGrowth({ before, after }) {
  const was = new Set(before ?? []);
  const added = (after ?? []).filter(f => !was.has(f));
  if (!added.length) return { ok: true, added: [], why: null };
  return { ok: false, added, why:
    "these test files were ADDED to GRANDFATHERED:\n" +
    added.map(f => `  ${f}`).join("\n") + "\n\n" +
    "The list is frozen debt, not an exemption list. A file with no stub arrives with\n" +
    "one or it does not arrive; a file that already had one does not get to give it up." };
}

/**
 * Which manifest anchors no longer resolve, without running a single test.
 *
 * PURE, and it reuses `countOccurrences` and `describeMiss` rather than restating
 * them: the sweep and this check must agree about what "resolves" means, and two
 * implementations of that would be the very defect being guarded -- a second
 * inventory of the same fact, correct until one of them moved.
 *
 * WHY IT EXISTS SEPARATELY FROM THE SWEEP. The sweep already reports an unresolved
 * anchor as UNRUNNABLE, and reports it well: the divergence point, the file's current
 * text, the entry that named it. But it costs about twenty minutes, because it runs
 * every named test twice. This costs under a second, because reading a file and
 * counting a substring is all the question needs.
 *
 * That gap is not a performance detail, it is the reason anchors rot into the default
 * branch. Measured 2026-08-30: two entries were verified CAUGHT when written, then
 * review fixes in the SAME pull request moved the lines they named -- a de-indent of
 * two spaces, and a condition split across three lines -- and the suite and the linter
 * both passed, because neither reads an anchor. The only thing that does was too slow
 * to run again before pushing.
 *
 * `read` is injected so this is testable without a filesystem, and so a caller can
 * decide what an unreadable file means rather than having that decided here.
 */
export function unresolvedAnchors(entries, { read, key }) {
  if (typeof read !== "function" || typeof key !== "function")
    throw new Error("unresolvedAnchors: needs { read, key }; the two must agree, because `key` is what `read` is given");
  const bad = [];
  for (const entry of entries ?? []) {
    // GROUPED BY FILE AND APPLIED IN ORDER, because that is what the sweep does:
    // `for (const ed of edits) src = applyEdit(src, ed)` over one in-memory source
    // per file. Re-reading the pristine file for each edit answers a different
    // question, and can answer it the opposite way -- an earlier replacement that
    // creates or removes a later anchor makes the two disagree, and the check would
    // then pass on a stub the sweep will refuse.
    // KEYED BY THE RUNNER'S OWN OPERATION, not by a path function that resembles it.
    // The sweep coalesces targets with `join(ROOT, e.file)` and manifest validation
    // accepts any non-empty string, so `f.mjs`, `./f.mjs` and `/f.mjs` are ONE file to
    // it. `normalize` models the first two and NOT the third -- `normalize("/f.mjs")`
    // stays absolute while `join(ROOT, "/f.mjs")` is the same target as `f.mjs`,
    // because join treats its later arguments as segments rather than as roots.
    //
    // Two spellings that the sweep coalesces and this check separates is a FALSE
    // GREEN: each group reads the pristine source, blind to what the other replaced.
    // That is the one failure mode a cheap precondition must not have, so the key is
    // `join` itself with a stand-in root, which reproduces the runner's equivalence
    // classes exactly. THE CALLER SUPPLIES BOTH `key` AND `read`, and they must agree:
    // `key` is what `read` is handed. A default key would have been a trap -- the
    // first version defaulted to a stand-in root while the test's reader held
    // unprefixed names, so every synthetic fixture answered ENOENT and four
    // assertions failed for a reason unrelated to what they measured.
    const byFile = new Map();
    for (const edit of entry?.edits ?? []) {
      const k = key(edit.file);
      if (!byFile.has(k)) byFile.set(k, []);
      byFile.get(k).push(edit);
    }
    for (const [file, edits] of byFile) {
      let src;
      try { src = read(file); }
      catch (e) { bad.push({ name: entry.name, file, count: null, why: `could not be read: ${e.message}` }); continue; }
      if (typeof src !== "string") {
        bad.push({ name: entry.name, file, count: null, why: "could not be read" });
        continue;
      }
      for (const edit of edits) {
        // `applyEdit` ITSELF, not a reimplementation of its rule. It already refuses
        // anything but exactly one occurrence and already explains a miss; calling it
        // is what makes this check and the sweep incapable of disagreeing about what
        // "resolves" means. A second implementation of that rule would be the second
        // inventory this whole class of defect is made of.
        try { src = applyEdit(src, edit); }
        catch (e) {
          const n = countOccurrences(src, edit.find);
          bad.push({ name: entry.name, file, count: n, why: String(e.message) });
          break;   // later edits are judged against a source this one did not produce
        }
      }
    }
  }
  return bad;
}
