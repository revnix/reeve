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

const binary = [];
for (const rel of tracked) {
  const buf = readFileSync(ROOT + rel);
  const at = buf.indexOf(0);
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

// ── `.pathname` off a file URL, which is a path that may not exist ──────────
//
// Here rather than in a test of its own because this file already owns the walk
// over every tracked source and the control that the walk found something. A
// second walker would be a second inventory of the same list, and the two would
// agree right up until one of them was filtered differently.
//
// MEASURED, on a directory named `dir with space/sub#hash`:
//
//   new URL(…) then .pathname   /…/dir%20with%20space/sub%23hash/x.mjs   existsSync -> FALSE
//   fileURLToPath(new URL(…))  /…/dir with space/sub#hash/probe.mjs    existsSync -> true
//
// The failure IMPERSONATES A DIFFERENT ONE, which is why it earns a guard rather
// than a comment. The percent-encoded path does not exist, so `existsSync` says
// false and a guarded block silently skips, or a spawn fails ENOENT and reads as
// "the binary is missing" rather than "the path was never decoded". Nothing
// reports that a decode was skipped.
//
// Node's fs API takes a URL object directly (`path: string | Buffer | URL`), so
// the fix is often to delete `.pathname` and pass the URL. Where a string is
// genuinely needed, `fileURLToPath` is the decoder.
{
  const RE = /new URL\([^)]*\)\s*\.pathname/;
  // The control is a DECOY as much as a positive: the first string must be caught
  // and the second must not. A rule that fires on the word `.pathname` would trip
  // on every comment explaining the rule, including this one, and the honest way
  // to find that out is to assert it here rather than to discover it in CI.
  const DOT = ".";
  check(RE.test(`const p = new URL("../bin/x", import.meta.url)${DOT}pathname;`),
    "control: the rule catches the shape it is about, assembled rather than written " +
    "out because this file is inside the set the scan walks");
  // The WRAPPED form, which the line-based scan could not see: no single line holds
  // the whole expression. Assembled from pieces for the same reason as the one above
  // -- this file is inside the set the scan walks.
  const wrapped = [`const p = new URL(`, `  "../x",`, `  import.meta.url`, `)${DOT}pathname;`].join("\n");
  check(RE.test(wrapped),
    "control: and catches it when the call is WRAPPED across lines, which is what a per-line scan missed",
    JSON.stringify(wrapped));
  check(!RE.test(`// fileURLToPath, NOT ${DOT}pathname, because a space arrives percent-encoded`),
    "control: and does NOT catch prose that merely names it, so the rule can be explained");

  // THE STUB MANIFEST IS EXEMPT, and this is a definition rather than a carve-out.
  // Its entire purpose is to hold text that REINTRODUCES a defect, so every guard
  // of this shape ships an entry whose `replace` string is the banned code. A
  // source-level ban cannot scan the one file whose job is to contain banned
  // source without refusing its own evidence.
  //
  // The exemption is asserted to be LOAD-BEARING below rather than left standing.
  // An exemption nobody exercises is one that has quietly become a blanket, and
  // the way to find out is to require that it still matters.
  const EXEMPT = "test/stub-manifest.mjs";
  // THE WHOLE FILE, not line by line. The character class already matches a newline,
  // so the pattern spans a wrapped call on its own -- but splitting the source first
  // meant no single line held the whole expression, so a call formatted across
  // several lines walked straight through. The rule was right; feeding it one line
  // at a time made it unable to fire.
  //
  // Line numbers come from the match OFFSET rather than from a split, so the report
  // still points at a line the reader can open.
  //
  // COMMENTS ARE SCANNED TOO, deliberately. Stripping them first would need a
  // parser, because `//` also appears inside strings, and a stripper that got that
  // wrong would delete real code from the text being searched -- turning a guard
  // that over-fires on prose into one that silently misses code. Over-firing is the
  // safe direction: the cost is rewording a sentence, and the message says which
  // line. This very comment was rewritten for that reason, which is also the
  // evidence that the scan reaches further than the line-based one did.
  const lineOf = (text, index) => text.slice(0, index).split("\n").length;
  const offenders = [], exempted = [];
  for (const rel of tracked) {
    if (!/\.(mjs|js)$/.test(rel)) continue;
    const into = rel === EXEMPT ? exempted : offenders;
    const text = readFileSync(ROOT + rel, "utf8");
    for (const m of text.matchAll(new RegExp(RE.source, "g")))
      into.push(`${rel}:${lineOf(text, m.index)}`);
  }
  check(exempted.length > 0,
    `control: ${EXEMPT} still contains the shape, so exempting it is load-bearing`,
    "if it no longer does, delete the exemption rather than leaving it to widen silently");
  check(offenders.length === 0,
    "no source takes `.pathname` off a file URL, which yields a percent-encoded path that may not exist",
    offenders.join("\n        ") + "\n        pass the URL object to fs, or decode it with fileURLToPath");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
