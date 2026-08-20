// A source file containing a raw NUL byte is BINARY to git. `git diff` then says
// "Binary files differ" and shows nothing, `git grep` skips it, and every review
// lens reading a diff sees an empty change. reconciler.mjs -- the file that
// decides whether a check run counts -- was in exactly that state because a NUL
// delimiter was written as a literal byte rather than the escape "\0".
//
// A system whose entire purpose is judging diffs cannot have files its own
// reviewers are blind to.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const tracked = execFileSync("git", ["-C", ROOT, "ls-files", "src", "bin", "test", "deploy"], { encoding: "utf8" })
  .split("\n").filter(Boolean);

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

check(tracked.length > 10, `control: found ${tracked.length} tracked source files to inspect`,
  "an empty file list would make every assertion below vacuous");

const binary = [];
for (const rel of tracked) {
  const buf = readFileSync(ROOT + rel);
  const at = buf.indexOf(0);
  if (at !== -1) binary.push(`${rel} (NUL at byte ${at}, line ${buf.subarray(0, at).toString("utf8").split("\n").length})`);
}
check(binary.length === 0, "no tracked source file contains a raw NUL byte",
  binary.join("\n        ") + "\n        write the escape \"\\0\" instead of the byte itself");

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
