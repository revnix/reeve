// A source file containing a raw NUL byte is BINARY to git. `git diff` then says
// "Binary files differ" and shows nothing, `git grep` skips it, and every review
// lens reading a diff sees an empty change. reconciler.mjs -- the file that
// decides whether a check run counts -- was in exactly that state because a NUL
// delimiter was written as a literal byte rather than the escape "\0".
//
// A system whose entire purpose is judging diffs cannot have files its own
// reviewers are blind to.
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "src", "bin", "test", "deploy"], { encoding: "utf8" })
  .split("\n").filter(Boolean);

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

check(tracked.length > 10, `control: found ${tracked.length} tracked source files to inspect`,
  "an empty file list would make every assertion below vacuous");

// THE DETECTOR, named so it can be tested on input that HAS the byte. The assertion
// below is about the tree and its expected value is zero, so breaking the detection
// cannot move it -- the check stays green however broken the scan is. Only synthetic
// input where the answer is non-zero can show the detector works at all.
const nulAt = buf => buf.indexOf(0);
check(nulAt(Buffer.from("ab\0cd", "utf8")) === 2,
  "the NUL detector finds the byte in a buffer that contains one",
  String(nulAt(Buffer.from("ab\0cd", "utf8"))));
check(nulAt(Buffer.from("abcd", "utf8")) === -1,
  "control: and answers -1 for a buffer that does not, so it is not simply always finding one");

const binary = [];
for (const rel of tracked) {
  const buf = readFileSync(ROOT + rel);
  const at = nulAt(buf);
  if (at !== -1) binary.push(`${rel} (NUL at byte ${at}, line ${buf.subarray(0, at).toString("utf8").split("\n").length})`);
}
check(binary.length === 0, "no tracked source file contains a raw NUL byte",
  binary.join("\n        ") + "\n        write the escape \"\\0\" instead of the byte itself");

// A raw ESC does not make a file binary, so the check above cannot see it -- but
// it defeats a reader the same way. ci-rootcause.mjs held one inside an ANSI
// stripper written with the byte itself, and it cost two failed edits: both the
// editor and a hand-written anchor matched the VISIBLE characters and missed the
// invisible one, so each replacement silently found nothing.
const esc = [];
for (const rel of tracked) {
  const buf = readFileSync(ROOT + rel);
  const at = buf.indexOf(0x1b);
  if (at !== -1) esc.push(`${rel} (ESC at byte ${at}, line ${buf.subarray(0, at).toString("utf8").split("\n").length})`);
}
check(esc.length === 0, "nor a raw ESC byte, which is invisible to every editor and search",
  esc.join("\n        ") + "\n        write the escape \"\\x1b\" instead of the byte itself");

// The authority on this is git, not my byte scan: attributes or a .gitattributes
// rule could also mark a file binary.
const asBinary = tracked.filter(rel => {
  try {
    const out = execFileSync("git", ["-C", ROOT, "grep", "-I", "--name-only", "-e", "", "--", rel], { encoding: "utf8" });
    return out.trim() === "";
  } catch { return true; }
});
check(asBinary.length === 0, "git treats every tracked source file as text",
  asBinary.join(", ") + "\n        a binary file shows as 'Binary files differ' in every review");

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
