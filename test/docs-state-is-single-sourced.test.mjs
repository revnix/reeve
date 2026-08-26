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

// Sentence machinery, at module scope because EVERY matcher needs it.
//
// A sentence ends at a stop, but these documents put emphasis and links between
// that stop and the next space -- "**...programme.** §3.2 says", or
// "[doctor reports degraded.](d.md) See §0.1" -- so a naive split leaves the
// paragraph whole, the §0 pointer in it exempts the lot, and the claim beside the
// pointer walks through. Both markdown link forms are removed first, leaving the
// visible text, which is what a reader reads and what these rules are about.
const SENTENCE = /(?<=[.!?][*_`"')\]]*)\s+/;
const unlink = s => s
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")     // [text](target)
  .replace(/\[([^\]]*)\]\[[^\]]*\]/g, "$1");   // [text][ref]
const sentencesOf = s => unlink(s).split(SENTENCE);
const defersToZero = s => /§0/.test(s.replace(/\(§0\)/g, ""));

const offendersIn = text => {
  const out = [];
  for (const b of blocksOf(text)) {
    // PER SENTENCE, like every other matcher in this file. This one was left
    // block-scoped when the others were fixed, and a claim beside a pointer went
    // straight through it -- "The work is still open. See §0 for details." was
    // green. Declaring a class swept is not sweeping it: the fix has to be
    // applied at every site, and this is the site that was missed.
    for (const sentence of sentencesOf(b.lines.join(" "))) {
      if (defersToZero(sentence)) continue;
      if (STATE_CLAIMS.some(re => re.test(sentence)))
        out.push(`${b.nums[0]}: ${sentence.trim().slice(0, 88)}`);
    }
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
  // DEFER OR DATE. One rule, and it cannot be wrong about English.
  //
  // This check used to try to understand grammar: whether a verb was past tense,
  // whether an outcome word described the rule or the build, whether a count was
  // history or work remaining. It took five review rounds and eighteen findings
  // and the counts went 6, 5, 1, 6 -- every round found another sentence shape
  // judged wrongly, and every fix traded a false alarm for a missed case or the
  // reverse. English has no end of shapes, so that instrument has no end of
  // rounds. The founder's call was to stop grinding it and change the instrument.
  //
  // What is left is mechanical. A sentence that names something §0 owns must
  // either point at §0, or carry a DATE. Nothing here inspects tense, mood or
  // predicate structure. A date is unambiguous where past tense is not, and both
  // ways of satisfying the rule are things an author can see and add:
  //
  //   "R-01 was broken on 2026-08-22."          -> dated, so it is history. Fine.
  //   "Whether R-01 is broken is a §0 fact."     -> defers. Fine.
  //   "R-01 is broken."                          -> neither. That is the defect.
  //
  // The cost is real and is the trade the founder chose: some historical prose
  // now carries a date it would not otherwise need. That is cheap, visible, and
  // never wrong -- which the grammar rules could not manage.
  const zero = /^## 0\. STATE[\s\S]*?(?=^## )/m.exec(handoff)?.[0] ?? "";

  // The subjects, derived from §0 so there is no second list to maintain.
  //
  // §0.2's row labels, and the backticked terms in §0.1's comments -- which is
  // where §0.1 already says what each command answers. A label needs more than
  // one word and one distinctive word: `main` alone appears in correct prose
  // everywhere, and a guard that fires on right text is weakened until it catches
  // nothing. That much judgement stays, because it is about naming rather than
  // about grammar, and it is settled by looking at §0 rather than at a sentence.
  const fromRows = [...zero.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
    .map(m => m[1].replace(/`/g, "").trim())
    .filter(s => s && !/^-+$/.test(s)
                 && s.split(/\s+/).length >= 2
                 && s.split(/[\s,]+/).some(w => w.length >= 6))
    .map(s => s.split(" — ")[0].trim());
  // A row's distinctive TOKENS, not only its whole label.
  //
  // Matching the label as one string is too literal to be useful: the row reads
  // "the durable-effect stages" and the prose says "the durable-effect programme",
  // the row reads "`--execute` is OFF on purpose" and the prose says "the
  // --execute flag". Both name the same owned fact and neither contains the
  // label. Backticked terms and hyphenated compounds are the parts prose actually
  // reuses, and they are distinctive enough not to fire on ordinary text.
  const fromLabelTokens = [...new Set([...zero.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
    .flatMap(m => [...m[1].matchAll(/`([^`]+)`/g)].map(b => b[1])
      .concat(m[1].split(/\s+/).filter(w => /^[a-z][a-z]+-[a-z-]+$/i.test(w))))
    .map(s => s.trim()).filter(s => s.length >= 6))];
  const bash = /```bash\n([\s\S]*?)```/.exec(zero)?.[1] ?? "";
  // The backticked terms in §0.1's COMMENTS, which is where §0.1 already says
  // what each command answers.
  const fromComments = [...bash.matchAll(/#[^\n]*/g)]
    .flatMap(m => [...m[0].matchAll(/`([^`]+)`/g)].map(b => b[1]))
    .map(s => s.trim()).filter(s => s.length >= 6);
  // And the COMMAND NAMES themselves. Dropping these was a regression I nearly
  // shipped: the simplification passed on clean documents, and the stub loop then
  // showed it caught NONE of the four defects the old rules had caught -- a
  // sentence stating a `doctor` outcome walked straight through. Simplifying the
  // DECISION is the change the founder asked for; narrowing what the decision is
  // made ABOUT was an accident of the same edit.
  const fromCommands = [...new Set(bash.split("\n")
    .map(l => l.split("#")[0].trim()).filter(Boolean)
    .flatMap(l => l.split(/\s+/).slice(0, 2))
    // A QUOTED token is an argument, never a command name. `grep "daemon
    // starting"` contributed `daemon`, which then matched every sentence in §1
    // describing what the daemon IS -- durable prose that has no business
    // deferring to §0. The rule fired on right text, which is how a guard gets
    // weakened until someone turns it off.
    .filter(w => !/^["']/.test(w))
    .map(w => w.replace(/^\.?\/?(?:bin\/)?/, "").replace(/[^\w-]/g, ""))
    .filter(w => w.length >= 6 && /^[a-z][\w-]*$/.test(w)))];
  const subjects = [...new Set([...fromRows, ...fromLabelTokens, ...fromComments, ...fromCommands])];

  // The RULE IDENTIFIERS, which §0.1's doctor line owns and no row names.
  // Mechanical: an R-number is unambiguous, and every claim about one is a claim
  // about what doctor currently reports. History carries a date and is excused
  // like anything else, so this needs no opinion about tense.
  const SUBJECT_PATTERNS = [[/\bR-\d+\b/, "an R-rule outcome"]];

  // A row's VALUE is owned by §0 as surely as its label, and a restatement never
  // contains the label -- which is how the founder's merge rule came to be copied
  // into the prompt in different words. Matched by distinctive-word OVERLAP,
  // because a restatement is never a substring. Four words from one row in one
  // sentence is a restatement; three fired on ordinary prose when I tried it.
  const STOP = new Set(["that","this","with","from","have","been","were","will","when","then",
                        "over","into","only","also","which","after","before","their","there",
                        "would","could","should","about","while","every","because","rather"]);
  const rowValues = [...zero.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)]
    .map(m => [m[1].replace(/`/g, "").trim(),
               [...new Set(m[2].toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
                 .filter(w => w.length >= 4 && !STOP.has(w)))]])
    .filter(([, ws]) => ws.length >= 5);

  check(subjects.length >= 8, "control: §0 yielded the subjects it owns",
    `${subjects.length}: ${subjects.join(" / ")}`);
  check(rowValues.length >= 3, "control: and the row VALUES a restatement would copy",
    rowValues.map(([l, w]) => `${l}(${w.length})`).join(" "));

  // A DATE, in any form these documents actually use. Mechanical, and the only
  // thing standing in for "this is history".
  const DATED = /\b20\d\d-\d\d-\d\d\b|\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/;
  // A HEADING or a bold LABEL names its subject; it does not assert anything about
  // it. Both are markdown structure rather than grammar, so recognising them
  // needs no opinion about English: a line beginning `#`, or a sentence wholly
  // wrapped in emphasis. Requiring "## 3. The durable-effect programme (§0)"
  // would be noise for no reader's benefit, and a rule that fires on right text
  // is weakened until someone turns it off.
  const isHeading = s => /^\s*#/.test(s);
  const isLabel = s => /^\s*\*\*[^*]+\*\*[.:,;]?\s*$/.test(s);
  const excused = s => defersToZero(s) || DATED.test(s) || isHeading(s) || isLabel(s);

  const offenders = [];
  for (const [label, text] of [[HANDOFF, handoff.replace(/^## 0\. STATE[\s\S]*?(?=^## )/m, "")], [PROMPT, prompt]])
    for (const b of blocksOf(text)) {
      // A HEADING is judged as a block, not as sentences. "## 3. The
      // durable-effect programme" splits at "3." into two, and the half carrying
      // the subject no longer looks like a heading -- so the exemption has to be
      // taken where the structure is still visible.
      if (isHeading(b.lines[0])) continue;
      // A LABEL carries its subject forward.
      //
      // "**R-01.** It is broken right now." is two sentences: the first is a label
      // and exempt, the second says "It" and names nothing. Neither offends, and
      // together they state exactly what this rule exists to stop. Resolving a
      // pronoun is grammar, and grammar is what was removed here -- but carrying
      // the label's subject into the sentences that follow it needs no grammar at
      // all, and covers the same case.
      let carried = [];
      for (const sentence of sentencesOf(b.lines.join(" "))) {
        const lower = sentence.toLowerCase();
        const here = subjects.filter(s => lower.includes(s.toLowerCase()))
          .concat(SUBJECT_PATTERNS.filter(([re]) => re.test(sentence)).map(([, n]) => n));
        if (isLabel(sentence)) { carried = here; continue; }
        if (excused(sentence)) { carried = []; continue; }
        const named = here.concat(carried.map(s => `${s} (from the label above)`))
          .concat(rowValues
            .filter(([, ws]) => ws.filter(w => new RegExp(`\\b${w}\\b`).test(lower)).length >= 4)
            .map(([l]) => `${l} (restated, not named)`));
        if (named.length)
          offenders.push(`${label}:${b.nums[0]} names "${named[0]}" and neither defers nor dates — ${sentence.trim().slice(0, 70)}`);
      }
    }
  check(offenders.length === 0,
    "every sentence naming something §0 owns either defers to §0 or carries a date",
    offenders.slice(0, 5).join("\n        "));

  // Controls. Both ways of satisfying the rule, and the shape that satisfies
  // neither -- driven through the same `excused` the scan uses, not a copy of it.
  for (const [what, sample, want] of [
    ["a bare state claim", "R-01 is broken.", false],
    ["one that defers to §0", "Whether R-01 is broken is a §0 fact.", true],
    ["one carrying an ISO date", "R-01 was broken on 2026-08-22.", true],
    ["one carrying a written date", "R-01 was broken on 22 Aug.", true],
    ["a dated count", "The last two PRs landed on 24 Aug.", true],
    ["an undated count", "The last two PRs of the programme.", false],
    ["a section heading", "## 3. The durable-effect programme", true],
    ["a bold label", "**R-01, the merge authority.**", true],

  ]) check(excused(sample) === want, `control: "defer or date" ${want ? "excuses" : "catches"} ${what}`, sample);

  check(fromLabelTokens.length >= 2, "control: §0's row labels yielded reusable terms",
    fromLabelTokens.join(" / "));
  check(SUBJECT_PATTERNS.every(([re]) => re.test("R-01 is broken.")),
    "control: and an R-number is recognised as a subject §0 owns", "");

  // And the two ways a sentence can hide from the scan, which are about markdown
  // rather than about grammar and are therefore still worth checking.
  check(sentencesOf("[doctor reports degraded.](d/e.md) See §0.1").length === 2,
    "control: a sentence ending inside an inline link is still two sentences", "");
  check(sentencesOf("[doctor reports degraded.][ref] See §0.1").length === 2,
    "control: and so is one inside a reference-style link", "");
  check(sentencesOf("**The last two PRs.** See §0.").length === 2,
    "control: and one ending in emphasis", "");
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
  // "them"/"these" both, and whitespace-flexible. Pinning a pronoun is the same
  // brittleness as pinning a line break, which already broke this check once:
  // the rule is the sentence, not the word chosen to point at its subject.
  check(/change\s+(them|these)\s+HERE\s+and\s+nowhere\s+else/i.test(zero),
    "§0 states the rule that keeps it single-sourced", zero.slice(0, 120));
  // And it must actually carry the volatile facts, or the pointers point at nothing.
  for (const fact of [/`main`/, /--execute/, /merged/])
    check(fact.test(zero), `§0 carries the fact matching ${fact}`, "");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
