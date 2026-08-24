// The handoff's §0 is the only place that states current facts. This test is what
// makes that true tomorrow rather than only today.
//
// Seven review rounds in a row found the same defect: a fact corrected in one
// place and left standing in another. The cause was not seven mistakes -- three
// volatile facts (what is merged, whether reeve is armed, what `main` is) had been
// restated in about twenty places across two documents, so patching whichever copy
// review landed on only moved which copy was wrong.
//
// Centralising them was necessary and not sufficient: the round after the §0
// section landed found the paragraph claiming "this document repeats no current
// facts" sitting three lines below a paragraph restating them, and the round after
// THAT found a new copy that had been added in the same commit as the claim.
// Declaring a class swept is itself an unverified read.
//
// So the invariant is enforced rather than intended: a present-tense claim about
// state may appear in the resume prompt only as a POINTER to §0.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, "..", "docs");

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// The CURRENT pair, resolved rather than named. A test pinned to one date guards
// the superseded documents and leaves the live ones unprotected the moment a new
// handoff is written -- which is the same half-an-invariant failure this test was
// widened to fix. Dates sort lexically here, so newest is last.
const newest = suffix => {
  const found = readdirSync(docs).filter(f => f.endsWith(suffix)).sort();
  if (!found.length) throw new Error(`no docs/*${suffix} at all`);
  return found[found.length - 1];
};
const PROMPT = newest("-resume-prompt.md");
const HANDOFF = newest("-session-handoff.md");
const prompt = readFileSync(join(docs, PROMPT), "utf8");
const handoff = readFileSync(join(docs, HANDOFF), "utf8");

// A SUPPLEMENTARY net, and it is important to be honest about which. Matching
// phrasings can only ever catch phrasings someone has already written: nine
// review rounds found nine this list did not have, and every one of them was
// found by a reader, not by this test. Deciding whether a sentence is volatile
// is not something a regex can do, so the checks that carry real weight are the
// two DERIVED ones further down -- one reads §0's own values, the other reads
// document structure -- and neither can lag the prose. This list stays because a
// cheap net that catches the obvious cases is still worth its two milliseconds.
const STATE_CLAIMS = [
  /\bis open\b/i, /\bstill open\b/i, /\bcurrently open\b/i, /\bremaining work\b/i,
  /\bis armed\b/i, /\bis disarmed\b/i, /\bawaiting review\b/i, /\bnot yet merged\b/i,
  // The SEMANTIC forms, added after the first version passed while two copies
  // remained: it matched the words I happened to have used rather than the claims
  // they made.
  //
  // PRESENT TENSE ONLY, and that is the whole distinction. "reeve is disarmed" is
  // a claim that expires; "reeve was disarmed on 23 Aug" is history and never
  // will. My first widening caught both and flagged three correct sentences --
  // a guard that fires on right text gets weakened or ignored, which costs more
  // than the copies it was added to catch.
  // No `is re-armed`: it only ever appears in a CONDITIONAL here ("when it is
  // re-armed, eligible will be narrower"), which is a durable statement about
  // behaviour rather than a claim about now. The `--execute` forms below already
  // cover the arming state, so this one bought nothing but a false positive.
  /\bis merged\b/i, /\bdefect is merged\b/i,
  /\bWITHOUT `--execute`/i, /\bwith `--execute`/i, /`--execute` is (on|off)\b/i,
];

/** Lines making a present-tense state claim without pointing at §0.
 *
 * The exemption is scoped to the claim's OWN block -- one bullet, or one
 * paragraph -- and not to a window of nearby lines. The window was the real hole
 * behind the eleventh copy: a legitimate pointer in the bullet ABOVE covered a
 * stale claim in the bullet below it, so the more §0 pointers a section
 * accumulated, the less of that section the test actually read. A guard that
 * weakens as it is used is worse than none, because it is trusted.
 *
 * A PARENTHETICAL `(§0)` also does not count. The eleventh copy read "**The
 * daemon's checkout is behind `main`** (§0)" -- it cited §0 and contradicted it in
 * one breath. An appended citation is a footnote on a copy, not a pointer: the
 * point of a pointer is that the fact is stated ONCE, so a line that both asserts
 * and cites has kept the copy and added a reference to the original. Forms that
 * defer -- "§0 says", "see §0", "is a §0 fact" -- survive, because they state
 * nothing that can go stale.
 *
 * Blocks break on a blank line and on the start of a new list item, so a wrapped
 * bullet still carries its own pointer while its neighbour's cannot reach it.
 */
const blocksOf = text => {
  const blocks = [];
  let cur = null;
  text.split("\n").forEach((line, i) => {
    const starts = /^\s*([-*+]|\d+\.|#{1,6}|\|)\s/.test(line);
    if (!line.trim()) { cur = null; return; }
    if (!cur || starts) { cur = { lines: [], nums: [] }; blocks.push(cur); }
    cur.lines.push(line); cur.nums.push(i + 1);
  });
  return blocks;
};

const offendersIn = text => {
  const out = [];
  for (const b of blocksOf(text)) {
    const joined = b.lines.join(" ");
    const defers = /§0/.test(joined.replace(/\(§0\)/g, ""));
    if (defers) continue;
    b.lines.forEach((line, k) => {
      if (STATE_CLAIMS.some(re => re.test(line))) out.push(`${b.nums[k]}: ${line.trim().slice(0, 88)}`);
    });
  }
  return out;
};

// --- the prompt states no current facts except as a pointer ------------------
{
  const offenders = offendersIn(prompt);
  check(offenders.length === 0,
    `${PROMPT} states no current facts except as a §0 pointer`,
    offenders.slice(0, 4).join("\n        "));
}

// --- and NEITHER does the handoff, outside §0 --------------------------------
//
// The first version of this test checked only the prompt, and passed while the
// handoff restated the same facts three sections down. Half an invariant reads
// exactly like a whole one.
{
  const withoutZero = handoff.replace(/^## 0\. STATE[\s\S]*?(?=^## )/m, "");
  check(withoutZero.length > 1000, "control: the handoff minus §0 is still most of the file", String(withoutZero.length));
  const offenders = offendersIn(withoutZero);
  check(offenders.length === 0,
    `${HANDOFF} states no current facts OUTSIDE §0`,
    offenders.slice(0, 4).join("\n        "));
}

// --- DERIVED: §0's own row labels are the policed vocabulary ------------------
//
// The check that would have caught the eleventh copy, and the reason it is worth
// having: every other matcher here enumerates something a person maintains, and a
// person maintains it by remembering. This one reads §0's table. Each row label is
// by construction the NAME of a fact that changes, so a block mentioning one and
// not deferring to §0 is a copy -- whatever words it uses to make the claim. Add a
// row to §0 and this starts policing that subject everywhere, with nothing to
// remember.
//
// Only multi-word labels are used. A label like `main` is one common word and
// would fire on correct prose everywhere, and a guard that fires on right text is
// weakened until it catches nothing.
{
  const zero = /^## 0\. STATE[\s\S]*?(?=^## )/m.exec(handoff)?.[0] ?? "";
  const subjects = [...zero.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
    .map(m => m[1].replace(/`/g, "").trim())
    // A label is usable as a search term when it has more than one word AND at
    // least one word distinctive enough not to appear everywhere. The first
    // version used a character count, which is a proxy for that and a bad one:
    // "the tracker" is eleven characters, fell under it, and the twelfth copy --
    // "the tracker has no record of 22-24 Aug at all" -- walked straight through.
    // Length was never the property that mattered; having a word worth searching
    // for was.
    .filter(s => s && !/^-+$/.test(s)
                 && s.split(/\s+/).length >= 2
                 && s.split(/[\s,]+/).some(w => w.length >= 6))
    // A label carrying an em-dash gloss ("capability 1 — watch, judge, escalate")
    // is policed by its stem, which is the part prose actually reuses.
    .map(s => s.split(" — ")[0].trim());
  check(subjects.length >= 4, "control: §0's table yielded subjects to police",
    `${subjects.length}: ${subjects.join(" / ")}`);

  const offenders = [];
  for (const [label, text] of [[HANDOFF, handoff.replace(/^## 0\. STATE[\s\S]*?(?=^## )/m, "")], [PROMPT, prompt]])
    for (const b of blocksOf(text)) {
      const joined = b.lines.join(" ");
      if (/§0/.test(joined.replace(/\(§0\)/g, ""))) continue;
      const named = subjects.filter(s => joined.toLowerCase().includes(s.toLowerCase()));
      if (named.length) offenders.push(`${label}:${b.nums[0]} names "${named[0]}" — ${joined.trim().slice(0, 70)}`);
    }
  check(offenders.length === 0, "no block outside §0 names a §0 subject without deferring to it",
    offenders.slice(0, 4).join("\n        "));
}

// --- DERIVED: the prompt names no PR and no commit ---------------------------
//
// Decidable, and it cannot lag the prose. A pull-request number and a commit hash
// are the two facts that expire fastest and the two that read as authoritative
// when they are stale, so the prompt carries neither and points at §0 instead.
// The handoff is deliberately NOT held to this: outside §0 it cites both as
// HISTORY ("merged in #19"), which never goes stale, and firing on correct text
// is how a guard gets weakened until it catches nothing.
{
  const lines = prompt.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    // A hash needs at least one digit, or ordinary words made only of a-f
    // ("defaced") match and the check starts crying wolf.
    const m = /(?<![\w#])#\d+\b/.exec(lines[i]) ?? /\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/.exec(lines[i]);
    if (m) hits.push(`${i + 1}: ${m[0]}  in  ${lines[i].trim().slice(0, 70)}`);
  }
  check(hits.length === 0, `${PROMPT} names no pull request and no commit`,
    hits.slice(0, 4).join("\n        "));
  // Control: the matcher can see what it is looking for. Without this a green
  // means "no PR numbers" and "the regex is broken" equally well.
  check(/(?<![\w#])#\d+\b/.test("see #19 for the fix"), "control: the PR matcher matches a PR number", "");
  check(/\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/.test("landed in 1385071"), "control: the commit matcher matches a hash", "");
  check(!/\b(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/.test("a defaced facade"), "control: and does not match ordinary words", "");
}

// --- DERIVED: no table outside §0 has a column that can only hold state -------
//
// The other decidable one, and it caught the shape the phrase list could not: §2
// tabulated the four capabilities with a `state` column, which is a copy of §0 by
// construction no matter how the cells are worded. A column headed state or
// status IS a state claim, whatever prose fills it, so the structure is checked
// rather than the words.
{
  const tablesOutsideZero = text => text.split("\n")
    .filter(l => /^\s*\|/.test(l) && /\|\s*(state|status|where it stands)\s*\|/i.test(l));
  const offenders = [...tablesOutsideZero(handoff.replace(/^## 0\. STATE[\s\S]*?(?=^## )/m, "")),
                     ...tablesOutsideZero(prompt)];
  check(offenders.length === 0, "no table outside §0 has a state column",
    offenders.slice(0, 3).join("\n        "));
  // Control: the matcher recognises the header it is looking for.
  check(tablesOutsideZero("| # | capability | state |").length === 1,
    "control: a state column is recognised when one is present", "");
}

// --- STRUCTURAL: the prompt file is the fenced block and nothing else ---------
//
// The tenth copy was not in the prompt a session receives. It was in the epilogue
// UNDER it -- "why the prompt is shaped this way" -- which is commentary about the
// document, and commentary about a document is exactly where facts about the
// document collect. No phrasing check would have been the answer; the answer was
// that there was prose there at all.
//
// So the surface is gone rather than policed: the file is a short header, one
// fenced block, and nothing after it. The rationale moved into the handoff, where
// rationale belongs. This is the third check here that decides structure instead
// of wording, and structure is the only thing about prose a test reads reliably.
{
  const lines = prompt.split("\n");
  const fences = lines.map((l, i) => [l, i]).filter(([l]) => l.startsWith("```")).map(([, i]) => i);
  check(fences.length === 2, `${PROMPT} has exactly one fenced block`, `found ${fences.length} fence lines`);
  const trailing = fences.length === 2 ? lines.slice(fences[1] + 1).join("").trim() : "";
  check(trailing === "", `${PROMPT} has nothing after the closing fence`,
    `${trailing.length} characters follow it, starting: ${trailing.slice(0, 70)}`);
  // Control: the scan can find a fence at all, so an empty result cannot be read
  // as a well-formed file.
  check(fences.length > 0, "control: the fence scan found the block it measures", "");
}

// --- and it says so, so a reader knows the rule -------------------------------
{
  check(/contains no current facts/i.test(prompt),
    `${PROMPT} tells the reader it holds no current facts`, "");
  check(/§0/.test(prompt), `${PROMPT} points at §0 at all`, "");
}

// --- §0 exists, and is where the facts live -----------------------------------
{
  check(/^## 0\. STATE/m.test(handoff), `${HANDOFF} has a §0 STATE section`, "");
  const zero = /^## 0\. STATE[\s\S]*?(?=^## )/m.exec(handoff)?.[0] ?? "";
  check(zero.length > 300, "control: §0 was extracted and is not empty", String(zero.length));
  // The rule has to be written where someone editing it will see it.
  // Whitespace-flexible: prose wraps, and where a line breaks is not a property
  // worth asserting. The first version of this check failed because the phrase
  // happened to span a newline.
  check(/change\s+them\s+HERE\s+and\s+nowhere\s+else/i.test(zero),
    "§0 states the rule that keeps it single-sourced", zero.slice(0, 120));
  // And it must actually carry the volatile facts, or the pointers point at nothing.
  for (const fact of [/`main`/, /--execute/, /merged/])
    check(fact.test(zero), `§0 carries the fact matching ${fact}`, "");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
