// artifact -- the durable phase artifact, and the read that checks it.
//
// A transition commits only after its artifact is durable, so the write has to
// be atomic against a crash and the sha recorded has to be the sha of the bytes
// that are actually on disk. Both halves matter: a sha computed from the buffer
// in memory certifies what was INTENDED, not what survived.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync,
         rmSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
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
export function writeArtifact({ dir, phase, bytes }) {
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
  const fresh = [];
  for (let d = dir; !existsSync(d) && d !== dirname(d); d = dirname(d)) fresh.push(d);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  reapStaleTemporaries(dir, name, Date.now());
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx");
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
  } catch (e) {
    // THE TEMPORARY GOES WITH THE FAILURE. A write that throws -- a full disk is
    // the ordinary case -- left its partial file behind, and every retry minted
    // another randomly named one. The space needed to recover is then consumed
    // by the failures, which turns a transient full disk into a permanent one.
    closeSync(fd);
    try { rmSync(tmp, { force: true }); } catch { /* the throw above is the real failure */ }
    throw e;
  }
  closeSync(fd);
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
  for (const made of fresh) {
    const pfd = openSync(dirname(made), "r");
    try { fsyncSync(pfd); } finally { closeSync(pfd); }
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
const CLAIM = /^\s*(?:[-*]|\d+\.)\s+\S/;
// A CITATION IS A PATH AND A LINE, not any token with a colon in it.
// `[\w./-]+:\d+` matched `12:30` and `issue:42` as readily as
// `src/build/hubaccess.mjs:170`, so a claim mentioning a time or a ticket read
// as sourced. The token must therefore carry the shape of a file: either a
// separator, or a name with an extension immediately before the colon.
const CITATION = /(?:[\w.-]*\/[\w./-]*|[\w-]+\.[A-Za-z][\w]{0,5}):\d+/;
// A URL's PORT is not a file citation, and research is full of URLs. `[\w./-]+:\d+`
// matches `localhost:3000` exactly as it matches `src/x.mjs:170`, so a claim
// supported by a link read as supported by a source line -- the gate accepting
// precisely the unsupported claims it exists to reject. URLs are removed before
// the test rather than excluded inside it, because a pattern that has to
// describe what a URL is not becomes a second, worse URL parser.
const URLS = /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi;
const withoutUrls = (line) => line.replace(URLS, " ");

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
  if (!expect || typeof expect.depth !== "string")
    throw new Error("reviewArtifact needs `expect` with a depth; expectations adjust by depth and a default would pick one");

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
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        findings.push(`sizing.json is ${Array.isArray(parsed) ? "an array" : JSON.stringify(parsed)}, ` +
                      `not an object; valid JSON is not a sizing`);
      else {
        // THE CONTRACT IS WRITTEN DOWN, so it is enforced rather than guessed.
        // I declined this once on the grounds that requiring fields would encode
        // what the sizing phase is merely EXPECTED to emit -- and that was wrong:
        // the design states the shape, so these are the artifact's terms and not
        // an assumption about a task nobody has written yet.
        //
        // The depth VALUE is still not re-checked here. The transition owns that
        // vocabulary and refuses an unknown depth durably; a copy of the list in
        // this file would be a second inventory of it.
        for (const field of ["depth", "est_files", "est_weighted_files", "est_packages",
                             "est_slices", "risk_paths_touched", "rationale"])
          if (!(field in parsed)) findings.push(`sizing.json omits ${field}`);
        if ("depth" in parsed && (typeof parsed.depth !== "string" || !parsed.depth.trim()))
          findings.push("sizing.json's depth is not a name; it is the field the phase machine reads");
      }
    }
  }
  if (phase === "RESEARCH") {
    if (expect.depth === "trivial")
      return { ok: false, why: "RESEARCH is skipped at trivial depth; there is no research artifact to gate",
               findings: [], sha256 };
    // PER CLAIM, not per file. A whole-file test passes as soon as ANY line
    // carries a citation, so an artifact with nine cited claims and one bare
    // assertion reads as clean -- and the bare one is the claim that needed
    // checking.
    let claims = 0;
    for (const line of text.split("\n")) {
      if (!CLAIM.test(line)) continue;
      claims++;
      if (!CITATION.test(withoutUrls(line))) findings.push(`no file:line citation: ${line.trim()}`);
    }
    // ABSENCE MUST NOT SATISFY THE RULE. With no claims the loop runs zero times
    // and every claim is trivially cited, so an empty artifact -- or one that is
    // all headings and prose -- passed a gate whose whole subject is the claims
    // it does not contain. "Nothing to check" is not "checked".
    if (claims === 0)
      findings.push("no claims at all: RESEARCH must produce findings, and an artifact with none " +
                    "satisfies the citation rule only because there is nothing to cite");
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
    const sections = lines.map((l, i) => (/^##\s+/.test(l) ? i : -1)).filter(i => i !== -1);
    const starts = lines.map((l, i) => (/^##\s+Slice\b/.test(l) ? i : -1)).filter(i => i !== -1);
    if (!starts.length) findings.push("design.md carries no ordered slice list");
    for (let k = 0; k < starts.length; k++) {
      const heading = lines[starts[k]].trim();
      const next = sections.find(i => i > starts[k]) ?? lines.length;
      const body = lines.slice(starts[k] + 1, next).join("\n");
      for (const need of ["Files:", "Packages:", "Tests:", "Done when:"]) {
        // THE LABEL IS NOT THE ANSWER. `includes` passed on the bare scaffold, so
        // a slice carrying the four headings and nothing after them advanced as
        // though it named its files, its tests and its done condition. What the
        // gate is for is the values.
        const line = body.split("\n").find(l => l.trim().startsWith(need));
        if (!line) findings.push(`${heading} has no ${need} line`);
        else if (!line.slice(line.indexOf(need) + need.length).trim())
          findings.push(`${heading} has a ${need} line with nothing after it`);
      }
    }
    if (expect.depth === "trivial" && !/^##\s+Measured context\b/m.test(text))
      findings.push("at trivial depth design.md stands in for the absent research and needs a Measured context section");
  }
  return findings.length
    ? { ok: false, why: `${ARTIFACT_FILE[phase]} does not meet the minimum for ${phase}`, findings, sha256 }
    : { ok: true, why: null, findings: [], sha256 };
}
