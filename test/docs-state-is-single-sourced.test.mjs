// NOT IN THE REVIEW ROTATION. Founder's decision, 2026-08-26: this file stays in
// CI and keeps working, but it is not sent for another adversarial review round.
// It reached ten rounds and forty-nine findings, and the last four were caused by
// the previous round's fix — each change opens a new surface in English rather
// than closing one in the code. It catches thirteen defect classes and spares
// five kinds of durable prose, which is the point at which more review buys
// edge cases in grammar at the cost of the capability reeve actually runs.
//
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
import { newestDoc } from "./newest-doc.mjs";
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
// Resolved by the SHARED helper, so this test and the agreement test cannot end
// up reading different documents -- which they would have the moment a same-day
// revision existed, since each had grown its own version of "newest".
const PROMPT = newestDoc(docs, "resume-prompt");
const HANDOFF = newestDoc(docs, "session-handoff");
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
// A PARENTHETICAL `(§0)` defers. It used to be stripped before this test, from a
// design where the exemption was block-scoped and a passing citation could excuse
// a whole paragraph. Under clause scoping that concern is gone -- the pointer
// only ever excuses the clause it sits in -- and the strip had become a direct
// contradiction: `(§0)` is exactly the form this rule now asks authors to write,
// and it was the one form that did not count.
const defersToZero = s => /§0/.test(s);

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
    // A LONG label is distinctive as a phrase, whatever its words. "the ntfy read
    // user" has no word of six characters and could not possibly fire on ordinary
    // prose -- the length filter exists to stop a single common word becoming a
    // subject, and it was rejecting whole phrases for the same reason.
    .filter(s => s && !/^-+$/.test(s)
                 && (s.split(/\s+/).length >= 4
                     || (s.split(/\s+/).length >= 2
                         && s.split(/[\s,]+/).some(w => w.length >= 6))))
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
  // NO LENGTH FILTER here, and that was a real hole. A term is in a §0.1 comment
  // and in backticks because §0.1 is naming it as the thing that command answers
  // -- `main`, `HEAD`, `run`. Dropping them for being short meant "HEAD points at
  // 1234567." passed, which is exactly a fact §0.1 exists to measure. The length
  // filter is for terms INFERRED from a label, where a common word would fire on
  // ordinary prose; these are declared, so there is nothing to infer.
  const fromComments = [...bash.matchAll(/#[^\n]*/g)]
    .flatMap(m => [...m[0].matchAll(/`([^`]+)`/g)].map(b => b[1]))
    .map(s => s.trim()).filter(Boolean);
  // And the COMMAND NAMES themselves. Dropping these was a regression I nearly
  // shipped: the simplification passed on clean documents, and the stub loop then
  // showed it caught NONE of the four defects the old rules had caught -- a
  // sentence stating a `doctor` outcome walked straight through. Simplifying the
  // DECISION is the change the founder asked for; narrowing what the decision is
  // made ABOUT was an accident of the same edit.
  const fromCommands = [...new Set(bash.split("\n")
    // A CONTINUATION line is not a command. The sqlite query wraps, and its
    // second line begins `(select count(*) ...` -- so `select` became a
    // "command name" and any durable sentence containing the word Select was
    // rejected. Continuations and quoted bodies are indented; command starts are
    // not, which is a fact about the block's own formatting rather than a guess.
    .filter(l => !/^\s/.test(l))
    .map(l => l.split("#")[0].trim()).filter(Boolean)
    // A SETUP builtin is not a state-reading command, and an OPTION is not a
    // subject. `export PATH=...` contributed `export`, and `sqlite3 -readonly`
    // contributed `readonly`, so ordinary prose using either word was rejected
    // for naming a fact §0 does not own.
    .filter(l => !/^(?:export|cd|set|source|unset|alias)\b/.test(l))
    .flatMap(l => l.split(/\s+/).slice(0, 2))
    .filter(w => !w.startsWith("-"))
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
  const SUBJECT_PATTERNS = [
    [/\bR-\d+\b/i, "an R-rule outcome"],
    // A BARE COMMIT HASH is a §0 fact whoever it belongs to, and naming its
    // subject is not always possible: "The running daemon is at abcdef1" is a
    // claim about what the process loaded, and the only word tying it to §0.1 is
    // `daemon` -- which these documents use constantly to say what reeve IS.
    // Policing the hash instead needs no subject at all, and the handoff carries
    // none outside §0 today, so it costs nothing. History cites pull requests,
    // which never go stale, and those are untouched.
    // At least one DIGIT. `deadbeef`, `facade`, `decade` and `access` are valid
    // hex and ordinary English, and rejecting a sentence for containing one would
    // be the kind of false alarm that gets a guard switched off. A real short sha
    // without a single digit is about one in a thousand, which is a residual I can
    // name rather than a hole I have not noticed.
    [/(?<![\w/#-])(?=[0-9a-f]{7,40}(?![\w/-]))[a-f]*[0-9][0-9a-f]*/, "a bare commit hash"],
  ];

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
  const DATE = /\b20\d\d-\d\d-\d\d\b|\b\d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/;
  // "SINCE <date>" is not history. It is a claim that reaches today with a
  // starting point attached, and a date escape that took it at face value would
  // excuse the most confident form of the thing this rule exists to stop:
  // "R-01 has been broken since 2026-08-22." Mechanical -- the word before the
  // date -- so it needs no view about tense.
  // A BOUNDED range is history: "from 2026-08-22 to 2026-08-24" has both ends, so
  // the state it describes has finished. Only an OPEN start reaches today.
  const BOUNDED = new RegExp(`\\bfrom\\s+(?:${DATE.source})\\s+(?:to|through|until)\\s+(?:${DATE.source})`, "i");
  // Bounded ranges are REMOVED before looking for an open one, rather than used to
  // suppress the search. "has been broken since 2026-08-22 following an outage
  // from 2026-08-20 to 2026-08-21" carries both: a live claim and a finished one.
  // Treating any bounded range as proof that nothing is ongoing let the second
  // excuse the first, which is the same mistake as a date excusing a whole
  // sentence -- an exemption earned by one part of the text, spent by another.
  const ONGOING = s => new RegExp(`\\b(since|as of|from)\\s+(?:${DATE.source})`, "i")
    .test(s.replace(new RegExp(BOUNDED.source, "gi"), " "));
  // A NOW-WORD beside a date is two time references that disagree, and the date
  // must not win. "R-01 was broken on 2026-08-22 and remains broken today" is
  // dated history welded to a live claim, and excusing the whole thing on the
  // date let the most confident form of a stale outcome through. Mechanical --
  // a closed list of words that mean "at the time of reading" -- so it needs no
  // view about tense, only the observation that a past date cannot make a
  // present-tense claim historical.
  const NOW_WORD = /\b(today|now|currently|still|at present|as things stand|remains?|these days)\b/i;
  // A date excuses a SIMPLE sentence. A compound one has to defer.
  const DATED = s => DATE.test(s) && !ONGOING(s) && !NOW_WORD.test(s) && !COMPOUND.test(s);
  // A HEADING or a bold LABEL names its subject; it does not assert anything about
  // it. Both are markdown structure rather than grammar, so recognising them
  // needs no opinion about English: a line beginning `#`, or a sentence wholly
  // wrapped in emphasis. Requiring "## 3. The durable-effect programme (§0)"
  // would be noise for no reader's benefit, and a rule that fires on right text
  // is weakened until someone turns it off.
  // WORD BOUNDARIES, not substrings. `main` is a subject and `remaining` contains
  // it, so a substring test rejected a sentence about a drainer's remaining
  // budget for naming the default branch. This had to arrive WITH the change that
  // stopped dropping short declared subjects: keeping `main` under a substring
  // test would have fired on ordinary prose everywhere, which is how a guard gets
  // switched off rather than fixed.
  const namesSubject = (sentence, s) => {
    // CASE MATTERS when the subject carries a capital. `HEAD` is a git ref and
    // `head` is an ordinary English word these documents use constantly -- "the
    // head, the profile", "the MERGED head" -- so a case-insensitive match
    // rejected four sentences that had nothing to do with the ref. A subject
    // written in lower case (`main`, `doctor`) is matched either way, because
    // nothing is lost by it.
    const cased = /[A-Z]/.test(s);
    const esc = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lead = /^[a-z0-9]/i.test(s) ? "\\b" : "";
    const tail = /[a-z0-9]$/i.test(s) ? "\\b" : "";
    return new RegExp(`${lead}${esc}${tail}`, cased ? "" : "i").test(sentence);
  };
  // NO STRUCTURAL EXEMPTIONS. Not for headings, not for bold labels, not for
  // table rows.
  //
  // I added all three to avoid editing prose, and review found a hole in each in
  // the round after it landed: a bold assertion at the END of a block counted as
  // a "lead-in" because something else in the block came first; a state claim
  // written as a heading vanished with the heading line; a state column under the
  // word "outcome" escaped both this scan and the rule that polices state
  // columns. Every fix made an exemption narrower and the next round found the
  // next shape -- which is the pattern "defer or date" was chosen to END, and I
  // had reintroduced it one softening at a time.
  //
  // The rule is the rule now. A heading or a label naming something §0 owns says
  // "(§0)" like any other text: a handful of one-time edits, against an unbounded
  // stream of exemption holes.
  //
  // CLAUSES, because a date excuses the clause it belongs to and not the sentence
  // around it. "R-01 was broken on 2026-08-22 and remains broken today" is two
  // claims -- one dated and finished, one live and naked -- and judging the
  // sentence whole let the date carry the live half.
  // NO CLAUSE SPLITTING. It is grammar, and grammar is what this rule replaced.
  //
  // I added it to close one real hole -- "R-01 was broken on 2026-08-22 and
  // remains broken today", where a date excused a live claim welded to history --
  // and it produced four findings of its own in the next round. A bounded range
  // in one half suppressed an ongoing claim in the other. A chain of coordinated
  // predicates lost the subject after the first joiner. Every conjunction was
  // read as a back-reference, even where the next clause had its own subject. And
  // a COMPOUND SUBJECT -- "R-01 and R-03 are §0 facts" -- was split into a
  // fragment that names a rule and a fragment that carries the pointer.
  //
  // Every one of those is a question about English sentence structure, which is
  // exactly what "defer or date" exists to avoid asking. So the machinery is gone
  // and one mechanical rule replaces it, below: a COMPOUND sentence cannot be
  // excused by a date alone.
  //
  // That is principled rather than expedient. A date excuses a sentence because
  // the sentence is history; history is a simple past statement, and a sentence
  // that joins two claims is where the ambiguity lives. An author with a compound
  // historical sentence writes two sentences or adds a pointer, and always knows
  // which. The cost lands on prose that mixes history with rationale, which the
  // founder already accepted for rule rationale.
  const COMPOUND = /;|\s+—\s+|,?\s+(?:and|but|although|though|while)\s+/i;
  const excused = s => defersToZero(s) || DATED(s);

  const offenders = [];
  for (const [label, text] of [[HANDOFF, handoff.replace(/^## 0\. STATE[\s\S]*?(?=^## )/m, "")], [PROMPT, prompt]])
    for (const b of blocksOf(text)) {
      // A HEADING is judged as a block, not as sentences. "## 3. The
      // durable-effect programme" splits at "3." into two, and the half carrying
      // the subject no longer looks like a heading -- so the exemption has to be
      // taken where the structure is still visible.
      // The heading LINE, not the block. Markdown does not require a blank line
      // after a heading, so "## Doctor state" followed straight by a paragraph is
      // one block -- and skipping the block skipped the paragraph with it.
      const body = b.lines;
      // A LABEL carries its subject forward.
      //
      // "**R-01.** It is broken right now." is two sentences: the first is a label
      // and exempt, the second says "It" and names nothing. Neither offends, and
      // together they state exactly what this rule exists to stop. Resolving a
      // pronoun is grammar, and grammar is what was removed here -- but carrying
      // the label's subject into the sentences that follow it needs no grammar at
      // all, and covers the same case.
      // A RESTATEMENT is judged per SENTENCE, not per clause, because that is the
      // unit it spans. "Merge as soon as CI is green and zero threads remain open"
      // reuses the merge rule's words across a conjunction, and clause splitting
      // -- added for dates, where a narrower unit is exactly right -- cut it below
      // the overlap threshold and it stopped being caught. Two rules, two units.
      for (const sentence of sentencesOf(body.join(" "))) {
        if (excused(sentence)) continue;
        const lower = sentence.toLowerCase();
        const restated = rowValues
          .filter(([, ws]) => ws.filter(w => new RegExp(`\\b${w}\\b`).test(lower)).length >= 4)
          .map(([l]) => `${l} (restated, not named)`);
        if (restated.length)
          offenders.push(`${label}:${b.nums[0]} restates "${restated[0]}" and neither defers nor dates — ${sentence.trim().slice(0, 70)}`);
      }

      const sentences = sentencesOf(body.join(" "));
      let carried = [];
      for (const sentence of sentences) {
        const lower = sentence.toLowerCase();
        const here = subjects.filter(s => namesSubject(sentence, s))
          .concat(SUBJECT_PATTERNS.filter(([re]) => re.test(sentence)).map(([, n]) => n));
        // An excused clause that NAMES a subject still carries it. "**R-01** (§0).
        // It is broken." was passing: the label deferred, `carried` was cleared,
        // and the pronoun that followed named nothing -- so adding the required
        // pointer to a label disabled the pronoun protection this loop exists for.
        // Carried for exactly ONE clause, which is what the pronoun case needs and
        // no more. Persisting it across the block made `--execute` condemn a later
        // sentence about `watch.reviewActions` -- a different subject entirely.
        // A subject reaches the clause that follows it and then stops.
        // Carried only into a clause that REFERS BACK -- one that opens with a
        // pronoun and names nothing of its own. "**R-01** (§0). It is broken."
        // is the case this exists for. Carrying into any following clause was
        // far too much: it made `--execute` condemn the next sentence, which is
        // about `watch.reviewActions` and a different subject entirely.
        // `it`, `they`, `both` — pronouns standing for a NAMED THING. `this` and
        // `that` were in this list and had to come out: they routinely stand for
        // the whole preceding statement rather than its subject, so "Then `main`
        // moved twice. That taught the harder half:" inherited `main` into a
        // sentence about a lesson. A pronoun that can refer to a proposition
        // cannot be used to carry a subject.
        const refersBack = /^\s*(it|they|both)\b/i.test(sentence);
        const inherited = here.length === 0 && refersBack ? carried : [];
        carried = here;
        if (excused(sentence)) continue;
        const named = here.concat(inherited.map(s => `${s} (carried from the sentence before)`));
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
    ["an ONGOING claim wearing a date", "R-01 has been broken since 2026-08-22.", false],
    // THE TRADE, stated rather than discovered again. Rationale that names an
    // R-rule is not excused: "R-01 requires a status check so a broken build
    // cannot merge" has to say "(§0 for its state)" or carry a date. The previous
    // design tried to tell rationale from a live claim by reading the sentence,
    // and that is what cost five rounds. Asking the author for four words is the
    // price of a rule that can never be wrong about English, and it is the price
    // the founder chose.
    ["rationale that names a rule, which must still defer",
     "R-01 requires a status check so a broken build cannot merge.", false],
    ["another ongoing form", "doctor has reported degraded as of 2026-08-22.", false],
    ["an undated count", "The last two PRs of the programme.", false],
    // Structure buys nothing now. A heading and a label are text like any other,
    // and each of these was an exemption that review found a hole in.
    ["a section heading naming a subject", "## 3. The durable-effect programme", false],
    ["the same heading, deferring", "## 3. The durable-effect programme (§0)", true],
    ["a bold label naming a subject", "**R-01, the merge authority.**", false],
    ["a bold label that defers", "**R-01** (§0), the merge authority.", true],
    ["a dated commit hash, which is history", "The daemon ran abcdef1 on 2026-08-24.", true],
    ["dated history welded to a live clause", "R-01 was broken on 2026-08-22 and remains broken today.", false],

  ]) check(excused(sample) === want, `control: "defer or date" ${want ? "excuses" : "catches"} ${what}`, sample);

  check(fromLabelTokens.length >= 2, "control: §0's row labels yielded reusable terms",
    fromLabelTokens.join(" / "));
  // These are SUBJECT patterns, not exemptions, so they are exercised directly.
  // Routing them through `excused` was testing the wrong function -- the same
  // mistake as an earlier control here that passed for a second reason.
  const asSubject = s => SUBJECT_PATTERNS.filter(([re]) => re.test(s)).map(([, n]) => n);
  for (const [what, sample, want] of [
    ["an R-number", "R-01 is broken.", "an R-rule outcome"],
    ["a bare commit hash", "The running daemon is at abcdef1.", "a bare commit hash"],
    ["a pull request number, which never goes stale", "Merged in #19.", null],
    ["an ordinary word that merely looks hexish", "The deadbeef case is documented.", null],
  ]) check(want ? asSubject(sample).includes(want) : asSubject(sample).length === 0,
           `control: ${want ? "recognised" : "spared"} — ${what}`, `${sample} -> ${asSubject(sample).join(", ") || "none"}`);

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
