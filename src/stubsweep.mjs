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
export function classify({ controlExit, stubExit, stubOutput = "", hashChanged, restored, expectRed, observed = null }) {
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
  const anyAssertion = observed ? observed.anyAssertionSeen : reportedAnyAssertion(stubOutput);
  // COUNTED AT INGESTION when the caller counted. A PASS line is an assertion
  // result even though no PASS line is ever retained, so asking the buffer whether
  // an assertion ran answers a question about RETENTION and reports the run as a
  // crash on the strength of it.
  const namedFailed = observed
    ? observed.namedFailSeen
    : failures.some(f => f.includes(expectRed));
  if (!anyAssertion)
    return { verdict: CRASHED,
             why: `the test exited ${stubExit} without reporting a single assertion, so it died rather than failed; ` +
                  "a runner reading only the exit code would have called this a pass" };
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
  const s = pathBuf.toString("utf8");
  return Buffer.from(s, "utf8").equals(pathBuf)
    ? s
    : `${s} <bytes ${createHash("sha256").update(pathBuf).digest("hex").slice(0, 16)}>`;
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
