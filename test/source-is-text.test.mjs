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
import { readFileSync, existsSync } from "node:fs";

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
  // NOT anchored on `new URL(`, and that is the second repair to this rule rather
  // than a preference. Requiring the constructor meant the character class had to
  // stop at the first `)`, so an argument containing a call slipped through -- and it
  // could never see the form where the URL is held in a variable first.
  //
  // The rule is simply: a `.pathname` read off ANYTHING. That is exact for nested
  // parentheses without a parser, because it never looks inside them, and it catches
  // the variable form for free. It is enforceable today because the repository has
  // ZERO reads of `.pathname` in code -- every remaining mention is prose in a
  // comment. A future legitimate use, on an http URL where `.pathname` is correct,
  // will hit this and can be exempted deliberately and visibly, which is the right
  // way round for a rule that is otherwise fail-closed.
  //
  // The character before the dot is what separates code from prose: an identifier or
  // a closing parenthesis is code, and every mention in a comment here is preceded by
  // a backtick.
  //
  // A NEWLINE MAY SIT BEFORE THE DOT, BUT A BARE SPACE MAY NOT, and the difference is
  // load-bearing rather than fussy. A member access wraps onto the next line, so code
  // can legitimately put whitespace there -- dropping that was a regression I
  // introduced while widening the rule, and my own wrapped control could not expose
  // it, because that control wrapped the ARGUMENTS and left the access adjacent. It
  // exercised a different kind of wrapping than the one that broke.
  //
  // But allowing ANY whitespace made every sentence of the form "NOT .pathname" match,
  // including the ones in this file explaining the rule. Wrapped code contains a
  // newline; prose on one line does not. That is the whole distinction, and it is why
  // the pattern asks for a line break rather than for whitespace.
  //
  // AND THE PROPERTY NAME MUST END. Without the boundary, `route.pathnamePrefix` and
  // any other identifier merely BEGINNING with the word failed the repository-wide
  // assertion while never reading `.pathname` at all -- a fail-closed rule is only
  // tolerable while it is also correct, and a false red that blocks unrelated code is
  // how a guard gets deleted rather than fixed.
  const RE = /[\w)](?:\s*\n\s*)?\??\.pathname\b/;
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
  check(RE.test(`const p = new URL(resolveName(), import.meta.url)${DOT}pathname;`),
    "control: and when an argument contains a CALL, which a pattern stopping at the first bracket could not see");
  check(RE.test(`const u = new URL(x); const p = u${DOT}pathname;`),
    "control: and when the URL is held in a VARIABLE first, which anchoring on the constructor could never see");
  // The MEMBER ACCESS wrapping, which is a different wrap from the one above: there
  // the arguments spanned lines and the access stayed adjacent; here the access
  // itself is on the next line, so the character before the dot is whitespace.
  const memberWrapped = [`new URL("../x", import.meta.url)`, `  ${DOT}pathname;`].join("\n");
  check(RE.test(memberWrapped),
    "control: and when the MEMBER ACCESS itself wraps onto the next line",
    JSON.stringify(memberWrapped));
  // OPTIONAL CHAINING reads the same property and returns the same percent-encoded
  // path whenever the receiver is present, so the character before the dot has to
  // allow the question mark as well as an identifier.
  check(RE.test(`const path = url?${DOT}pathname;`),
    "control: and when the read is OPTIONAL, which returns the same path whenever the receiver exists");
  check(!RE.test(`const q = url?${DOT}pathnamePrefix;`),
    "control: but an OPTIONAL read of a longer name is still not a match, so the boundary survives the chaining");
  check(!RE.test(`const p = route${DOT}pathnamePrefix;`),
    "control: and does NOT fire on an identifier that merely BEGINS with the word, which would be a false red blocking unrelated code");
  check(!RE.test(`const q = url${DOT}pathnameEncoded;`),
    "control: nor on another such identifier, so the boundary is about the property name and not about one spelling");
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
  // CAPTURED FIXTURE DATA IS NOT SOURCE, and excluding it is not a weakening of the
  // scope fix that removed the extension filter. That fix was right: the inventory
  // decides what is in scope, and a suffix test was a second and narrower opinion
  // that happened to delete the production CLI. But the inventory also carries
  // reviewer bodies captured verbatim, and
  // test/fixtures/reviewer-bodies-2026-08-22/PROVENANCE.md requires them written to
  // disk unmodified, not retyped and not summarised.
  //
  // So a captured body that happens to contain this property name in ordinary prose
  // would fail a repository-wide guard and COULD NOT BE REWORDED without invalidating
  // the fixture. That is the one shape where over-firing is not merely noisy: there
  // is no correct action available to whoever hits it.
  const DATA = "test/fixtures/";
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
  const offenders = [], exempted = []; let data = 0;
  // EVERY tracked file, with no extension filter. `bin/reeve` is the production CLI
  // entry point, is JavaScript, and has no extension -- so a suffix test skipped the
  // single file where this defect would matter most while the assertion claimed to
  // cover all tracked source. The inventory already decides what is in scope; a
  // second, narrower opinion about scope was the bug.
  for (const rel of tracked) {
    if (rel.startsWith(DATA)) { data++; continue; }
    const into = rel === EXEMPT ? exempted : offenders;
    const text = readFileSync(ROOT + rel, "utf8");
    for (const m of text.matchAll(new RegExp(RE.source, "g")))
      into.push(`${rel}:${lineOf(text, m.index)}`);
  }
  check(data > 0,
    `control: ${data} captured fixture file(s) were skipped, so the data exclusion is load-bearing rather than a dead branch`);
  check(existsSync(ROOT + "test/fixtures/reviewer-bodies-2026-08-22/PROVENANCE.md"),
    "control: and the provenance rule that justifies skipping them is still on disk, so the exclusion cites something real");
  check(exempted.length > 0,
    `control: ${EXEMPT} still contains the shape, so exempting it is load-bearing`,
    "if it no longer does, delete the exemption rather than leaving it to widen silently");
  check(offenders.length === 0,
    "no source reads `.pathname`, which yields a percent-encoded path that may not exist",
    offenders.join("\n        ") + "\n        pass the URL object to fs, or decode it with fileURLToPath");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
