// artifact -- the durable phase artifact, and the read that checks it.
//
// A transition commits only after its artifact is durable, so the write has to
// be atomic against a crash and the sha recorded has to be the sha of the bytes
// that are actually on disk. Both halves matter: a sha computed from the buffer
// in memory certifies what was INTENDED, not what survived.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readFileSync,
         rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ARTIFACT_FILE } from "../paths.mjs";

const sha = (buf) => createHash("sha256").update(buf).digest("hex");

/** tmp + fsync + rename + fsync of the directory. Every step, in that order. */
export function writeArtifact({ dir, phase, bytes }) {
  const name = ARTIFACT_FILE[phase];
  if (!name) throw new Error(`${phase} produces no artifact; use reviewDiff's path`);
  // THE DIRECTORY MAY NOT EXIST YET, and whether it did decides what has to be
  // fsynced. `mkdirSync` writes the new entry into the PARENT, so fsyncing only
  // the artifact directory persists the file and the directory's contents while
  // leaving the directory's own entry unflushed -- a crash then loses the whole
  // tree, after `writeArtifact` reported it durable.
  const fresh = !existsSync(dir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
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
  renameSync(tmp, path);
  // THE DIRECTORY TOO. Without it the rename itself may not survive a crash,
  // and the artifact is durable only in the sense that its bytes were.
  const dfd = openSync(dir, "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  // AND ITS PARENT, when this call created the directory. Persisting a
  // directory's contents does not persist the fact that the directory exists.
  if (fresh) {
    const pfd = openSync(dirname(dir), "r");
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
const CITATION = /[\w./-]+:\d+/;

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
    try { JSON.parse(text); } catch (e) { findings.push(`sizing.json does not parse: ${e.message}`); }
  }
  if (phase === "RESEARCH") {
    if (expect.depth === "trivial")
      return { ok: false, why: "RESEARCH is skipped at trivial depth; there is no research artifact to gate",
               findings: [], sha256 };
    // PER CLAIM, not per file. A whole-file test passes as soon as ANY line
    // carries a citation, so an artifact with nine cited claims and one bare
    // assertion reads as clean -- and the bare one is the claim that needed
    // checking.
    for (const line of text.split("\n"))
      if (CLAIM.test(line) && !CITATION.test(line)) findings.push(`no file:line citation: ${line.trim()}`);
  }
  if (phase === "DESIGN") {
    const slices = text.split("\n").filter(l => /^##\s+Slice\b/.test(l));
    if (!slices.length) findings.push("design.md carries no ordered slice list");
    for (const need of ["Files:", "Packages:", "Tests:", "Done when:"])
      if (!text.includes(need)) findings.push(`every slice needs a ${need} line and none was found`);
    if (expect.depth === "trivial" && !/^##\s+Measured context\b/m.test(text))
      findings.push("at trivial depth design.md stands in for the absent research and needs a Measured context section");
  }
  return findings.length
    ? { ok: false, why: `${ARTIFACT_FILE[phase]} does not meet the minimum for ${phase}`, findings, sha256 }
    : { ok: true, why: null, findings: [], sha256 };
}
