// artifact -- the durable phase artifact, and the read that checks it.
//
// A transition commits only after its artifact is durable, so the write has to
// be atomic against a crash and the sha recorded has to be the sha of the bytes
// that are actually on disk. Both halves matter: a sha computed from the buffer
// in memory certifies what was INTENDED, not what survived.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync,
         rmSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ARTIFACT_FILE } from "../paths.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * How old a temporary must be before another writer may remove it.
 *
 * A worker killed between the open and the rename leaves its temporary behind
 * for ever: the rename is what publishes a file, so nothing else references it
 * and nothing else was ever going to remove it. Repeated crashes therefore
 * accumulate full-size artifacts in the tree, and the first symptom is a disk
 * that is full for reasons nobody can find.
 *
 * AGE, not process identity. A pid is the obvious discriminator and it is wrong:
 * pids are reused, so a live writer's temporary can carry a pid this process now
 * believes is dead. An hour is far longer than any artifact write and far
 * shorter than the time it takes an abandoned one to matter.
 */
const STALE_TMP_MS = 60 * 60 * 1000;

/**
 * Remove temporaries left by writers that never reached their rename.
 *
 * BEST EFFORT, and it never throws. Reaping is housekeeping; a failure to tidy
 * must not fail the write that was asked for, and a caller cannot act on it.
 */
function reapStaleTemporaries(dir, name, now) {
  try {
    for (const entry of readdirSync(dir)) {
      if (!entry.startsWith(`${name}.tmp-`)) continue;
      const full = join(dir, entry);
      try {
        if (now - statSync(full).mtimeMs > STALE_TMP_MS) rmSync(full, { force: true });
      } catch { /* raced with its owner, or already gone */ }
    }
  } catch { /* the directory is unreadable; the write below will say so */ }
}

/** tmp + fsync + rename + fsync of the directory. Every step, in that order. */
export function writeArtifact({ dir, phase, bytes, anchor = null }) {
  const name = ARTIFACT_FILE[phase];
  if (!name) throw new Error(`${phase} produces no artifact; use reviewDiff's path`);
  // THE DIRECTORY MAY NOT EXIST YET, and whether it did decides what has to be
  // fsynced. `mkdirSync` writes the new entry into the PARENT, so fsyncing only
  // the artifact directory persists the file and the directory's contents while
  // leaving the directory's own entry unflushed -- a crash then loses the whole
  // tree, after `writeArtifact` reported it durable.
  // EVERY ancestor this call creates, not just the one. `mkdirSync` with
  // `recursive` can create a whole chain -- tasks/<id>/artifacts on the first
  // artifact of the first task -- and each new directory is an entry in ITS
  // parent. Syncing only the deepest one leaves the entries that name it
  // unflushed, so a crash removes the tree the artifact was reported durable in.
  // THE CHAIN IS SYNCED WHETHER OR NOT THIS CALL CREATED IT. Recording only what
  // this process found missing loses a race: two first writes overlap, the other
  // creates the tree and is still writing its temporary, this one observes the
  // directories as existing, records nothing, and returns having synced only the
  // leaf -- reporting durability for a tree whose entries are still unflushed.
  //
  // Syncing an already-durable directory costs one fsync and answers the
  // question the caller actually asked, which is whether the artifact survives.
  //
  // NOT A COUNT, AND NOT THE FILESYSTEM ROOT EITHER. The cap was eight, which
  // meant a deeper tree silently stopped being synced above that level --
  // durability reported for entries never flushed, by a bound chosen to stop a
  // loop rather than because eight meant anything. Removing it walked to `/`,
  // which is the opposite mistake: every ancestor of the home belongs to the
  // operator or the OS, this write changes none of their entries, and one of
  // them being execute-only or on a filesystem whose directories cannot be
  // opened made the parent-sync loop RETHROW -- reporting a failure for an
  // artifact that was written and renamed successfully.
  //
  // `anchor` is the caller's own root, and the chain stops there. It bounds the
  // walk by OWNERSHIP rather than by depth, so a deeper tree is still synced to
  // the top and nothing above the anchor is touched. The race that makes the
  // whole chain worth syncing -- another process created the tree and has not
  // flushed its entries yet -- can only involve directories reeve creates, and
  // every one of those is below the anchor.
  const chain = [];
  if (anchor === null) {
    for (let d = dir; d !== dirname(d); d = dirname(d)) chain.push(d);
  } else {
    // RESOLVED ON THE FILESYSTEM, not lexically. `resolve` only normalises the
    // text, so a SYMLINK anywhere beneath the anchor satisfies `startsWith` while
    // the write lands wherever the link points -- `mkdirSync`, the temporary and
    // the rename all follow it. An anchored path under `home/tasks` writes
    // outside the home the moment `home/tasks` is a link, and the rename would
    // replace whatever design.md it found there.
    //
    // The anchor must exist to be resolved at all; `dir` usually does not yet, so
    // its DEEPEST EXISTING ancestor is resolved instead and the remainder is
    // appended. That is the part the filesystem can answer -- a component that
    // does not exist cannot be a link to anywhere.
    const realOf = (p) => {
      let head = resolve(p);
      const tail = [];
      for (;;) {
        try { return join(realpathSync(head), ...tail.reverse()); }
        catch { /* keep climbing */ }
        const up = dirname(head);
        if (up === head) return resolve(p);        // nothing on this path exists
        tail.push(head.slice(up.length + 1));
        head = up;
      }
    };
    const top = realOf(anchor);
    const start = realOf(dir);
    if (start !== top && !start.startsWith(top + sep))
      throw new Error(`${dir} resolves to ${start}, which is not inside ${anchor} (${top}); ` +
                      `the sync chain has no anchor to stop at, and a write there would leave the task tree`);
    for (let d = start; ; d = dirname(d)) { chain.push(d); if (d === top || d === dirname(d)) break; }
  }
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  reapStaleTemporaries(dir, name, Date.now());
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx");
  let closed = false;
  try {
    // WRITTEN TO COMPLETION, not merely handed over. `writeSync` may return
    // having written FEWER bytes than it was given, and a partial write that is
    // then fsynced and renamed produces a file that is present, correctly named,
    // and short -- with a sha reported for bytes that are not all there. The
    // loop is what makes the sha describe the file.
    let off = 0;
    while (off < bytes.length) {
      const n = writeSync(fd, bytes, off, bytes.length - off);
      if (n <= 0) throw new Error(`writeSync made no progress at byte ${off} of ${bytes.length}`);
      off += n;
    }
    fsyncSync(fd);
    // CLOSED INSIDE THE GUARDED REGION. `closeSync` can throw in its own right --
    // a deferred write error surfaces there on some filesystems -- and closing
    // outside the try left the temporary behind for exactly the failure the
    // cleanup exists to handle. Third leak in this family: the write was
    // covered, then the rename, and the close between them was not.
    closed = true;
    closeSync(fd);
  } catch (e) {
    // THE TEMPORARY GOES WITH THE FAILURE. A write that throws -- a full disk is
    // the ordinary case -- left its partial file behind, and every retry minted
    // another randomly named one. The space needed to recover is then consumed
    // by the failures, which turns a transient full disk into a permanent one.
    if (!closed) { try { closeSync(fd); } catch { /* the throw below is the real failure */ } }
    try { rmSync(tmp, { force: true }); } catch { /* the throw below is the real failure */ }
    throw e;
  }
  // THE RENAME IS INSIDE THE CLEANUP TOO. It was outside it, so a rename that
  // failed -- the destination has become a directory, or the filesystem refuses
  // the metadata update -- left a COMPLETE temporary behind, and every retry
  // left another. That is the same defect as the failed-write case, in the same
  // function, three lines further down: one site fixed and its sibling left.
  //
  // `force` makes the removal a no-op once the rename has succeeded, so the
  // successful path pays nothing for this.
  try {
    renameSync(tmp, path);
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* the rename failure is the real one */ }
    throw e;
  }
  // THE DIRECTORY TOO. Without it the rename itself may not survive a crash,
  // and the artifact is durable only in the sense that its bytes were.
  const dfd = openSync(dir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  // AND THE PARENT OF EVERY DIRECTORY THIS CALL CREATED. Persisting a
  // directory's contents does not persist the fact that the directory exists.
  // `fresh` runs deepest-first, so the parents are synced from the inside out.
  for (const made of chain) {
    const parent = dirname(made);
    try {
      const pfd = openSync(parent, "r");
      try { fsyncSync(pfd); } finally { closeSync(pfd); }
    } catch (e) {
      // ONLY A DIRECTORY THIS CALL DOES NOT OWN MAY FAIL SILENTLY. The blanket
      // catch swallowed everything, so an EIO on a parent INSIDE the task's tree
      // read the same as a permission error on a directory above it -- and
      // writeArtifact returned a sha for an artifact whose tree was not durable.
      // A guard that cannot fail is not a guard, and this one was reporting
      // success for the storage failures it exists to notice.
      //
      // The tree this call owns is the chain it just created plus the leaf; a
      // parent of one of those failing is a real failure. Anything above is
      // somebody else's directory and its refusal is not ours to raise.
      if (chain.includes(parent) || parent === dir) throw e;
    }
  }
  return { path, sha256: sha(bytes), bytes: bytes.length };
}

/**
 * Read it back and check it. `expectSha` is required: a read that returns
 * whatever is there certifies nothing, and this function exists to be the check.
 */
export function readArtifact({ dir, phase, expectSha }) {
  const name = ARTIFACT_FILE[phase];
  if (!name) throw new Error(`${phase} produces no artifact; use reviewDiff's path`);
  if (typeof expectSha !== "string" || expectSha.length !== 64)
    throw new Error("readArtifact needs the sha it expects; a read with nothing to compare is not a check");
  let buf;
  try { buf = readFileSync(join(dir, name)); }
  catch (e) { return { ok: false, why: `${name} is not there: ${e.code ?? e.message}` }; }
  const got = sha(buf);
  if (got !== expectSha)
    return { ok: false, why: `${name}'s sha is ${got}, not the recorded ${expectSha}; the bytes changed after the write` };
  return { ok: true, text: buf.toString("utf8"), sha256: got };
}

// A claim is a list item that asserts something. The per-action minimum for
// research is at least one file:line citation per claim. Prose between the lists
// is context, not a claim, and is not asked to cite.
// EVERY STANDARD LIST MARKER. `-`, `*` and `1.` were recognised and `+` and
// `1)` were not, so an uncited claim written with either was not a claim at all
// and slipped past the citation rule entirely -- the check silently narrowing
// its own input rather than failing.
// CAPTURING, because nesting is measured from the parts. `\s` also matches a
// newline, which is meaningless on a single line and makes the indent it reports
// wrong; `[ \t]` is what a Markdown indent is made of.
const CLAIM = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)\S/;
// A CITATION IS A PATH AND A LINE, not any token with a colon in it.
// `[\w./-]+:\d+` matched `12:30` and `issue:42` as readily as
// `src/build/hubaccess.mjs:170`, so a claim mentioning a time or a ticket read
// as sourced. The token must therefore carry the shape of a file: either a
// separator, or a name with an extension immediately before the colon.
// The extension is not length-capped. `{0,5}` refused `src/x.markdown:12` and
// `a.config.mjs:3` -- a correctly cited claim rejected because its filename was
// long, which is the gate refusing correct work over a number nobody chose
// deliberately. What distinguishes a file from a URL port is the DOT, not how
// many letters follow it.
const CITATION = /(?:[\w.-]*\/[\w./-]*|[\w-]+\.[A-Za-z][\w-]*):\d+/;
// A URL's PORT is not a file citation, and research is full of URLs. `[\w./-]+:\d+`
// matches `localhost:3000` exactly as it matches `src/x.mjs:170`, so a claim
// supported by a link read as supported by a source line -- the gate accepting
// precisely the unsupported claims it exists to reject. URLs are removed before
// the test rather than excluded inside it, because a pattern that has to
// describe what a URL is not becomes a second, worse URL parser.
// AND A SCHEME-LESS ENDPOINT IS NOT ONE EITHER. The URL strip only removes
// `scheme://...`, so `api.internal:3000/health`, `//api.internal:3000` and
// `git@host:22` all survived it and their PORT read as a line number. Each of
// these carries a syntactic marker that a file reference does not -- a
// protocol-relative prefix, a userinfo `@`, or a path after the port -- so each
// is removable without guessing.
//
// WHAT REMAINS, AND DELIBERATELY. A bare `api.internal:3000`, with no scheme, no
// userinfo and no path, is byte-for-byte the same SHAPE as `package.json:3000`:
// a dotted name, a colon, digits. No regex separates them, and the two errors are
// not symmetric -- accepting the endpoint lets one claim through uncited, while
// refusing the filename refuses every citation of a root-level file and fails the
// whole report. This file has already been corrected once for refusing correct
// work over a rule nobody chose deliberately, so the ambiguity is resolved
// towards accepting. The durable answer is not syntactic: a phase task holds the
// repository and can ask whether the cited path EXISTS, which is the only thing
// that actually tells the two apart.
const ENDPOINTS = [
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,             // a full URL
  /(?:^|[\s(<[])\/\/[\w.-]+:\d+\S*/g,          // a protocol-relative authority
  /\b[\w.-]+@[\w.-]+:\d+\S*/g,                // userinfo@host:port
  /\b[\w-]+(?:\.[\w-]+)+:\d+\/\S*/g,          // host:port followed by a path
];
const withoutEndpoints = (line) => ENDPOINTS.reduce((s, re) => s.replace(re, " "), line);

/**
 * The gate for a report phase's product. The SIBLING of `reviewDiff`, never a
 * parameter of it: an optional safety parameter is omitted by exactly the caller
 * that needs it, and two functions that refuse each other's phases cannot be.
 *
 * Every property is required. `expect` carries the depth because the minimum
 * changes with it, and a default would silently pick one.
 */
export function reviewArtifact({ phase, dir, expect }) {
  if (!ARTIFACT_FILE[phase])
    throw new Error(`${phase} produces a diff, not an artifact; reviewDiff is its gate`);
  // `expect` IS REQUIRED; a DEPTH INSIDE IT IS NOT.
  //
  // The phase tasks that call this pass `researchExpectations(depth)` and
  // `designExpectations(depth)`, whose documented result is the requirement set
  // -- `{minCitationsPerClaim, minClaims}` -- and carries no `depth` field: the
  // depth is an INPUT to those helpers, not an output. Demanding one here threw
  // before reading the artifact, so the gate refused its own documented callers
  // while every test that hand-built an expect object passed.
  //
  // So the object is required, because a gate with no expectations is not a
  // gate, and the depth is used when it is supplied. What depends on it says so
  // at the point of use rather than being assumed present.
  if (!expect || typeof expect !== "object")
    throw new Error("reviewArtifact needs an `expect` object; a gate with nothing to check against is not a check");

  // READ AS BYTES, so the digest below is of exactly what was reviewed. An
  // artifact replaced between the write and this gate -- by a recovered attempt,
  // or a concurrent one -- is validated here and then recorded under the earlier
  // write's sha, so the transition binds to bytes this gate never saw.
  let buf;
  try { buf = readFileSync(join(dir, ARTIFACT_FILE[phase])); }
  catch (e) { return { ok: false, why: `${ARTIFACT_FILE[phase]} is not there: ${e.code ?? e.message}`,
                       findings: [], sha256: null }; }
  const text = buf.toString("utf8");
  const sha256 = sha(buf);

  const findings = [];
  if (phase === "SIZING") {
    // PARSING IS NOT ENOUGH. `null`, `[]` and `{}` are all valid JSON and none is
    // a sizing, so the phase advanced on an artifact carrying no decision.
    //
    // What is asserted here is the SHAPE its consumer reads, and nothing more:
    // the transition refuses a SIZING report whose depth is not one of the known
    // depths, and it owns that vocabulary. Repeating the list here would be a
    // second inventory of it, and the two would agree until one changed.
    let parsed = null, ok = true;
    try { parsed = JSON.parse(text); }
    catch (e) { ok = false; findings.push(`sizing.json does not parse: ${e.message}`); }
    if (ok) {
      // THE SHAPE TEST AND THE FIELD LOOP ARE GUARDED SEPARATELY, not by one
      // if/else. Chained, removing the shape test lets the field loop run on a
      // non-object and `field in null` THROWS -- so the guard's absence crashes
      // the gate instead of answering wrongly, and a crash cannot be told from a
      // refusal by anything downstream. Guarded independently, a missing shape
      // test produces a wrong ANSWER, which is a thing a test can see.
      const isSizingObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
      if (!isSizingObject)
        findings.push(`sizing.json is ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}, ` +
                      `not an object; valid JSON is not a sizing`);
      if (isSizingObject) {
        // THE CONTRACT IS WRITTEN DOWN, so it is enforced rather than guessed.
        // I declined this once on the grounds that requiring fields would encode
        // what the sizing phase is merely EXPECTED to emit -- and that was wrong:
        // the design states the shape, so these are the artifact's terms and not
        // an assumption about a task nobody has written yet.
        //
        // The depth VALUE is still not re-checked here. The transition owns that
        // vocabulary and refuses an unknown depth durably; a copy of the list in
        // this file would be a second inventory of it.
        // PRESENCE AND TYPE. Presence alone let `est_files: "lots"` satisfy the
        // contract, and the floors that read those numbers compare them -- so a
        // string passes the gate and then produces a comparison nobody can
        // reason about. The kinds here are the ones the fields' own names imply,
        // and each is stated once.
        // THE TYPES ARE THE SCHEMA'S, not this file's recollection of them.
        // `build_size.json` declares all four counts as `{"type": "integer",
        // "minimum": 0}`. Three of them were checked here with `Number.isFinite`
        // and one with `Number.isInteger` -- so `est_files: 0.5` passed this
        // gate and was durably approved, while the same document validated
        // against the schema is refused. One artifact, two verdicts, and the
        // gate is the one that says the work may proceed.
        //
        // The divergence WAS the three copies: a predicate written out four
        // times, corrected in one of them. It is spelled once now, so the next
        // correction cannot land in three places out of four.
        const count = (v) => Number.isInteger(v) && v >= 0;
        const KIND = {
          depth: ["a name", (v) => typeof v === "string" && v.trim() !== ""],
          est_files: ["a whole number", count],
          est_weighted_files: ["a whole number", count],
          est_packages: ["a whole number", count],
          est_slices: ["a whole number", count],
          // THE ITEMS, not just the container. `Array.isArray` alone admitted
          // `[3]` and `[""]`, and this list is intersected against the profile's
          // risk paths to decide whether the sizing floor fires. A non-string
          // matches no path, so an artifact naming its risk paths as numbers
          // reads as touching none -- and the floor that exists for exactly that
          // case does not fire, silently, on the artifact that most needed it.
          risk_paths_touched: ["a list of non-empty paths",
            (v) => Array.isArray(v) && v.every((p) => typeof p === "string" && p.trim() !== "")],
          rationale: ["a non-empty string", (v) => typeof v === "string" && v.trim() !== ""],
        };
        for (const [field, [kind, ok]] of Object.entries(KIND)) {
          if (!(field in parsed)) { findings.push(`sizing.json omits ${field}`); continue; }
          if (!ok(parsed[field]))
            findings.push(`sizing.json's ${field} is ${JSON.stringify(parsed[field])}, not ${kind}`);
        }
      }
    }
  }
  if (phase === "RESEARCH") {
    // THE CALLER'S FLAG FIRST, depth as the fallback. Keyed on `expect.depth`
    // alone this branch is unreachable from the documented caller, which passes
    // the helper's requirement set and no depth -- so the one path the check
    // exists for could never be taken.
    // AND AN EXPECTATION THAT SAYS NEITHER IS REFUSED, rather than assumed to
    // mean "not skipped".
    //
    // This branch has now been unreachable twice. First it keyed on
    // `expect.depth`, which the documented helper does not carry. Reading the
    // caller's `skipped` flag instead was still one layer short: S3-D's
    // `researchExpectations(depth)` returns `{minCitationsPerClaim, minClaims}`
    // and carries NEITHER -- so the ternary fell through to `undefined ===
    // "trivial"`, false, every time, and the gate would review a research
    // artifact for a phase that should not have run.
    //
    // Guessing in either direction is wrong and the two errors are not
    // symmetric: assuming NOT skipped gates a phase that should have been
    // skipped, silently, which is the case this branch exists to prevent.
    // Assuming skipped refuses work that should be reviewed, loudly. So it
    // refuses to guess, which also makes the contract enforceable: S3-D's helper
    // must carry `skipped`, and until it does the refusal says so by name
    // instead of the branch quietly never running.
    if (!("skipped" in expect) && !("depth" in expect))
      return { ok: false, why: "this expectation says neither whether RESEARCH was skipped nor at what depth, " +
                               "and the two are different artifacts to gate; researchExpectations must carry `skipped`",
               findings: [], sha256 };
    const researchSkipped = "skipped" in expect ? expect.skipped : expect.depth === "trivial";
    if (researchSkipped)
      return { ok: false, why: "RESEARCH is skipped at this depth; there is no research artifact to gate",
               findings: [], sha256 };
    // The caller's declared minimum, when it declares one. The phase helpers
    // return `{minCitationsPerClaim, minClaims}`; a depth-carrying caller does
    // not, so the default stands in for it.
    var minClaims = Number.isInteger(expect.minClaims) ? expect.minClaims : 1;
    const minCites = Number.isInteger(expect.minCitationsPerClaim) ? expect.minCitationsPerClaim : 1;
    // PER CLAIM, not per file. A whole-file test passes as soon as ANY line
    // carries a citation, so an artifact with nine cited claims and one bare
    // assertion reads as clean -- and the bare one is the claim that needed
    // checking.
    // CLAIMS LIVE UNDER `## Findings` WHEN THE DOCUMENT HAS ONE. The contract
    // defines a claim as a bullet in that section, and scanning the whole
    // document made every bullet elsewhere a claim -- so a valid report with a
    // `## Limitations` note saying the network was unavailable was REFUSED for
    // failing to cite it. A document with no Findings heading is still scanned
    // whole, because refusing to look is not better than looking too widely.
    const scope = (() => {
      const rows = text.split("\n");
      const at = rows.findIndex(l => /^##\s+Findings\b/i.test(l));
      if (at === -1) return rows;
      const end = rows.findIndex((l, i) => i > at && /^##\s+/.test(l));
      return rows.slice(at + 1, end === -1 ? rows.length : end);
    })();
    let claims = 0;
    // NESTING IS RELATIVE, not "carries a leading space".
    //
    // A nested bullet elaborating a cited claim must not be counted as a claim of
    // its own -- the more carefully a finding is broken down, the more the gate
    // would penalise it. But `/^\s+/` answers a different question: Markdown
    // keeps a list item TOP-LEVEL at up to three spaces of indent, and nests one
    // only when it reaches the CONTENT column of the item above it. So ` - an
    // unsupported claim`, indented by a single space, was skipped entirely -- and
    // with one properly cited claim elsewhere satisfying `minClaims`, the
    // artifact passed. One space nobody would notice turned the citation rule off
    // for that line.
    //
    // `open` holds the content column of each list level currently open. A bullet
    // at or beyond the innermost of them is nested; one to its left closes levels
    // until it is not.
    const open = [];
    // AND A LIST ENDS. `open` described the list currently being read, and
    // nothing ever closed it -- so a cited list, a blank line, a paragraph, and
    // then a NEW list starting with one to three spaces had its first item
    // measured against the OLD list's content column and skipped as nested. The
    // new list's uncited claim disappeared from the count, and the artifact
    // passed. Markdown ends a list at a blank line followed by a block that is
    // not part of it; a paragraph indented into the item is a continuation and
    // does not.
    const width = (s) => s.replace(/\t/g, "    ").length;
    let blank = false;
    for (const line of scope) {
      if (line.trim() === "") { blank = true; continue; }
      const m = CLAIM.exec(line);
      if (!m) {
        const indent = width(/^[ \t]*/.exec(line)[0]);
        if (blank && (open.length === 0 || indent < open[open.length - 1])) open.length = 0;
        blank = false;
        continue;
      }
      blank = false;
      const indent = width(m[1]);
      while (open.length && indent < open[open.length - 1]) open.pop();
      const nested = open.length > 0;
      open.push(indent + m[2].length + width(m[3]));
      if (nested) continue;
      claims++;
      // THE COUNT THE CALLER ASKED FOR. `minCitationsPerClaim` was read and
      // ignored, so a claim with one citation satisfied a caller asking for two.
      // An argument accepted and not applied is worse than one absent, because
      // the caller believes it took effect.
      const cites = (withoutEndpoints(line).match(new RegExp(CITATION.source, "g")) ?? []).length;
      if (cites < minCites)
        findings.push(cites === 0 ? `no file:line citation: ${line.trim()}`
          : `${cites} citation(s) against a minimum of ${minCites}: ${line.trim()}`);
    }
    // ABSENCE MUST NOT SATISFY THE RULE. With no claims the loop runs zero times
    // and every claim is trivially cited, so an empty artifact -- or one that is
    // all headings and prose -- passed a gate whose whole subject is the claims
    // it does not contain. "Nothing to check" is not "checked".
    if (claims < minClaims)
      findings.push(`${claims} claim(s) against a minimum of ${minClaims}: RESEARCH must produce findings, ` +
                    "and an artifact with none satisfies the citation rule only because there is nothing to cite");
  }
  if (phase === "DESIGN") {
    // PER SLICE, not per document -- the same distinction the citation check
    // above makes, and it was missing here. A whole-document `includes` passes as
    // soon as ONE slice carries each label, so a design whose first slice is
    // complete and whose second is an empty heading read as clean, and the phase
    // advanced with a slice that names no files, no tests and no done condition.
    const lines = text.split("\n");
    // A SLICE ENDS AT THE NEXT SECTION, of any kind -- not at the next SLICE.
    // Bounding the last slice at end-of-file let a trailing section's labels be
    // read as that slice's, so an empty final slice followed by a Notes section
    // carrying the four labels passed. The heading that ends a slice is the next
    // heading, whatever it is called.
    // BOTH DOCUMENTED SHAPES. This plan writes a slice as a level-two `## Slice
    // 1`; the phase plan that will actually EMIT design.md writes `## Slices`
    // holding level-three `### Slice 1: ...`. Matching only the first found zero
    // slices in the artifact the producer is specified to write, so the gate
    // would have refused correct work with "carries no ordered slice list" --
    // the two plans disagree, and a gate that accepts only its own plan's shape
    // rejects the other's.
    //
    // `## Slices` is a CONTAINER and not a slice: `Slice\b` does not match it,
    // which is what keeps the container heading out of the slice list.
    const SLICE = /^#{2,3}\s+Slice\b/;
    const sections = lines.map((l, i) => (/^#{2,3}\s+/.test(l) ? i : -1)).filter(i => i !== -1);
    const starts = lines.map((l, i) => (SLICE.test(l) ? i : -1)).filter(i => i !== -1);
    if (!starts.length) findings.push("design.md carries no ordered slice list");
    for (let k = 0; k < starts.length; k++) {
      const heading = lines[starts[k]].trim();
      const next = sections.find(i => i > starts[k]) ?? lines.length;
      const body = lines.slice(starts[k] + 1, next).join("\n");
      // The same disagreement in the labels: this plan asks for `Tests:` and the
      // producing plan writes `Test plan:`. Either satisfies the requirement,
      // which is that the slice says how it will be tested.
      for (const need of [["Files:"], ["Packages:"], ["Tests:", "Test plan:"], ["Done when:"]]) {
        // THE LABEL IS NOT THE ANSWER. `includes` passed on the bare scaffold, so
        // a slice carrying the four headings and nothing after them advanced as
        // though it named its files, its tests and its done condition. What the
        // gate is for is the values.
        // A LIST ITEM IS STILL THE LABEL. The producer writes `- Files: ...`, so
        // the marker is stripped before the label is looked for.
        const bare = (l) => l.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, "");
        const rows = body.split("\n");
        const label = need.find(n => rows.some(l => bare(l).startsWith(n)));
        if (!label) { findings.push(`${heading} has no ${need[0]} line`); continue; }
        const at = rows.findIndex(l => bare(l).startsWith(label));
        // THE VALUE MAY FOLLOW THE LABEL RATHER THAN SIT ON ITS LINE. The
        // producing plan writes `Done when:` alone with a fenced command beneath
        // it, so a same-line-only check called the documented artifact empty --
        // the gate refusing correct work while every hand-written fixture passed.
        //
        // So: content after the colon, or any non-blank line before the next
        // label or heading. Bounded that way rather than by blank lines, because
        // the documented block is separated from its label by one.
        const nextBoundary = (rs, from) => {
          let chars = 0;
          for (let j = from; j < rs.length; j++) {
            if (j > from && /^#{2,3}\s+/.test(rs[j])) return chars;
            chars += rs[j].length + 1;
          }
          return chars;
        };
        const isBoundary = (l) => /^#{2,3}\s+/.test(l) ||
          ["Files:", "Packages:", "Tests:", "Test plan:", "Done when:"].some(n => bare(l).startsWith(n));
        let has = !!bare(rows[at]).slice(label.length).trim();
        for (let j = at + 1; j < rows.length && !has; j++) {
          if (isBoundary(rows[j])) break;
          if (rows[j].trim()) has = true;
        }
        if (!has) { findings.push(`${heading} has a ${label} line with nothing after it`); continue; }
        // A DONE CONDITION IS MACHINE-CHECKABLE WHEN THE CALLER SAYS SO. The
        // contract defines that as a fenced block inside the slice whose first
        // line is a command; `Done when: someone approves` satisfies "has a
        // value" and is not a completion check anybody can run.
        //
        // Gated on the caller's declared requirement rather than applied always,
        // because the phase task that owns this minimum is the one that sets the
        // flag -- and a caller that has not asked for it is not asking this gate
        // to invent it. The checker does not RUN the command and does not claim
        // to; it refuses a slice with no such block.
        if (label === "Done when:" && expect.requireDoneCondition === true) {
          const after = rows.slice(at).join("\n");
          // OPENED AND CLOSED. An unterminated fence satisfied an opening-fence
          // test, and half a block is not a done condition -- the rest of the
          // document is then inside it, so what the slice actually asks for is
          // whatever happens to follow.
          const within = after.slice(0, nextBoundary(rows, at));
          // A REGEX CANNOT PAIR FENCES, so this scans lines instead.
          //
          // Three defects in one expression, each fixed and the next one
          // appearing behind it. A bare ``` at both ends let four backticks be
          // closed by three. A backreference fixed that until the greedy prefix
          // BACKTRACKED and read the surrendered backtick as the info string.
          // Narrowing the info string fixed that, and then an EMPTY block --
          // opener, immediate closer, prose, another delimiter -- matched
          // starting at the CLOSER, taking it for an opener and the prose for a
          // command.
          //
          // That last one is not a pattern bug. Which delimiters open and which
          // close is decided by everything before them, and `m` lets a match
          // begin anywhere; no amount of lookahead recovers the state a scan
          // from the start carries for free. So the fourth attempt is not
          // another expression.
          //
          // The rules are CommonMark's: a closer is at least as long as its
          // opener and carries no info string, an empty block holds no command,
          // and a block that never closes is not a done condition however much
          // text follows it.
          const doneCommand = (within) => {
            let open = null, first = null;
            for (const line of within.split("\n")) {
              // AT MOST THREE SPACES. Four or more makes the line an indented CODE
              // BLOCK, not a fence -- so a `Done when:` written with a
              // four-space fence renders as literal text and this gate approved
              // it as a machine-checkable command. `[ \t]*` accepted any
              // indent; the limit is CommonMark's and a tab is worth four, so
              // neither is admitted here.
              const m = /^ {0,3}(`{3,})([^`\n]*)$/.exec(line);
              if (open === null) { if (m) { open = m[1]; first = null; } continue; }
              if (m && m[1].length >= open.length && m[2].trim() === "") {
                if (first !== null) return first;
                open = null; first = null; continue;
              }
              if (first === null && line.trim() !== "") first = line.trim();
            }
            return null;
          };
          const fence = doneCommand(within);
          if (fence === null) findings.push(`${heading} has no machine-checkable done condition: ` +
            `the contract asks for a fenced block, opened AND closed, whose first line is a command`);
        }
      }
    }
    // DECLARED REQUIREMENTS FIRST, depth as the fallback. The phase helper
    // returns `{requireSliceList, requireDoneCondition, requireMeasuredContext,
    // minSlices}` and carries no depth, so a gate keyed on depth alone ignores
    // everything its documented caller asked for.
    const wantsMeasured = "requireMeasuredContext" in expect
      ? expect.requireMeasuredContext : expect.depth === "trivial";
    if (Number.isInteger(expect.minSlices) && starts.length < expect.minSlices)
      findings.push(`${starts.length} slice(s) against a minimum of ${expect.minSlices}`);
    if (wantsMeasured && !/^##\s+Measured context\b/m.test(text))
      findings.push("design.md needs a Measured context section: it stands in for the research the depth skipped");
  }
  return findings.length
    ? { ok: false, why: `${ARTIFACT_FILE[phase]} does not meet the minimum for ${phase}`, findings, sha256 }
    : { ok: true, why: null, findings: [], sha256 };
}
