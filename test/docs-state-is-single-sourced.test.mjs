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
  // §0.1's COMMANDS are subjects too, and leaving them out was a real gap.
  //
  // The rule §0 states is that a fact a command can answer must not be written
  // down. The guard only policed §0.2's table, so §0.2's subjects were enforced
  // and §0.1's were not -- and a sentence asserting yesterday's `doctor` outcome
  // sat outside §0 through a passing run of this very test. The half of §0 that
  // matters MORE was the unpoliced half.
  //
  // Derived from the block rather than listed here, so adding a command to §0.1
  // starts policing it with no second place to remember. Only tokens long enough
  // to be distinctive: `git`, `gh`, `ps` and `grep` appear in correct prose
  // everywhere, and a guard that fires on right text is weakened until it catches
  // nothing.
  const commands = [...new Set(
    (/```bash\n([\s\S]*?)```/.exec(zero)?.[1] ?? "")
      .split("\n")
      // A TRAILING comment is still a comment. Splitting the whole line pulled
      // prose out of `grep ... # the review shadow streak` and started policing
      // the word "review", which fires on correct text in both documents.
      .map(l => l.split("#")[0].trim())
      .filter(Boolean)
      // The executable and its subcommand only. Arguments are paths, flags and
      // repository names, none of which is the name of a question.
      .flatMap(l => l.split(/\s+/).slice(0, 2))
      .map(w => w.replace(/^\.?\/?(?:bin\/)?/, "").replace(/[^\w-]/g, ""))
      .filter(w => w.length >= 6 && /^[a-z][\w-]*$/.test(w)))];

  // The SHORT commands need their subject, because their name is not usable.
  //
  // `git`, `gh` and `ps` are three, two and two characters and appear in correct
  // prose everywhere, so the length filter above drops them -- which left the
  // measurements they perform completely unpoliced while this test claimed to
  // cover §0.1. Demonstrated rather than argued: "the current main tip contains
  // the outbox repair" outside §0 passed a green run of this file.
  //
  // §0.1 already names each subject, in backticks, in the comment on its own
  // line. That is the thing to read: a command added with a comment is policed by
  // what the comment says it answers, and there is no second list to maintain.
  const subjectsInComments = [...new Set(
    [...(/```bash\n([\s\S]*?)```/.exec(zero)?.[1] ?? "").matchAll(/#[^\n]*/g)]
      .flatMap(m => [...m[0].matchAll(/`([^`]+)`/g)].map(b => b[1]))
      .map(s => s.trim().toLowerCase())
      .filter(s => s && s.length >= 3))];

  check(commands.length >= 2, "control: §0.1's command block yielded commands to police",
    commands.join(" / "));
  check(subjectsInComments.length >= 2,
    "control: and its comments yielded the subjects its short commands measure",
    subjectsInComments.join(" / "));

  // A row's VALUE is as volatile as its label, and it was not policed at all.
  //
  // The label check catches "the founder's merge rule says X". It does not catch a
  // paragraph that never names the rule and simply RESTATES it -- which is what the
  // resume prompt did with the merge condition, through green runs of this file.
  // §0 says change these here and nowhere else; a copy that avoids the label is
  // still a copy, and it is the one that goes stale silently because nothing links
  // it back.
  //
  // Matched by distinctive-word OVERLAP rather than as a substring, because a
  // restatement is never a substring: "merge on CI green AND zero open threads"
  // became "merge when CI is green AND zero threads are open". Four words from one
  // row, in one sentence, is a restatement rather than a coincidence -- three
  // fired on ordinary prose when I tried it.
  const STOP = new Set(["that","this","with","from","have","been","were","will","when","then",
                        "over","into","only","also","which","after","before","their","there",
                        "would","could","should","about","while","every","because","rather"]);
  const rowWords = [...zero.matchAll(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/gm)]
    .map(m => [m[1].replace(/`/g, "").trim(),
               [...new Set(m[2].toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
                 .filter(w => w.length >= 4 && !STOP.has(w)))]])
    .filter(([, ws]) => ws.length >= 5);
  check(rowWords.length >= 3, "control: §0's rows yielded VALUES to police, not only labels",
    rowWords.map(([l, w]) => `${l}(${w.length})`).join(" "));

  check(subjects.length >= 4, "control: §0's table yielded subjects to police",
    `${subjects.length}: ${subjects.join(" / ")}`);

  // A claim about a COMMAND is judged per SENTENCE, not per block.
  //
  // The block-scoped exemption is right for a table subject: a paragraph that
  // defers to §0 is discussing the subject, not restating it. It is wrong here,
  // and measurably so. The sentence this whole widening exists to catch --
  // "doctor reports the repository declares squash while 8 of the last 20 commits
  // are merge commits" -- sat in a paragraph that already ended with "see §0.1",
  // so a block-scoped test waved it through, and I confirmed that by putting the
  // sentence back and watching the guard stay green. A paragraph can defer to §0
  // and still copy an answer out of it, so the deferral has to be in the same
  // breath as the claim.
  const esc = s => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  const CLAIM = c => new RegExp(
    `\\b${esc(c)}\\b[^.]{0,40}\\b(reports?|said|says?|shows?|returns?|answers?|reported|contains?|sits at|is at|points at|tip|broken|degraded|clean|zero|empty)\\b`, "i");
  // Sentence boundaries have to survive MARKDOWN, or the whole rule is inert.
  //
  // `/(?<=[.!?])\s+/` requires whitespace immediately after the stop, and these
  // documents write emphasis: "**The last two PRs of the programme.** §3.2 says…"
  // puts `**` between the two. Nothing split there, the paragraph stayed one
  // "sentence", it contained a §0 pointer, and it was exempt in full -- so the
  // rule written to catch exactly that line did not catch it. Measured: the stub
  // stayed green until this changed.
  const SENTENCE = /(?<=[.!?][*_`"')\]]*)\s+/;

  // ...and markdown LINKS, which the character class above cannot express.
  //
  // `[doctor reports degraded.](details) See §0.1` puts a whole URL between the
  // stop and the whitespace, so nothing splits, the combined string carries the
  // §0 pointer, and the claim is exempt in full -- the same failure the emphasis
  // case had, reached through syntax no widening of that class can cover. Link
  // syntax is removed before splitting instead, leaving the visible text, which
  // is what a reader reads and what these rules are about.
  const unlink = s => s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const sentencesOf = s => unlink(s).split(SENTENCE);

  // THE PREDICATES, defined ONCE and called by both the scan and its controls.
  //
  // They were inline regexes, duplicated into the control loop as separate
  // literal copies. That is a control on the wrong side of a boundary: weaken or
  // replace the production matcher and the controls keep compiling their own
  // copies and stay green, so the check that exists to prove the guard still runs
  // could not see the guard stop running. The clean documents supply no positive
  // match of their own, so nothing else would have noticed either.
  //
  // `statesRuleOutcome` requires a STATE-BEARING predicate, not every definitional
  // use of a verb. "R-01 is the merge-authority check" and "R-01 requires a status
  // check" are what §6 is FOR -- durable statements of what a rule means -- and an
  // earlier version rejected both, because it fired on `is` or `requires` within
  // forty characters and spared only the single verb its control happened to pick.
  // What makes a sentence a copy of doctor's answer is the OUTCOME word.
  const RULE_OUTCOME = /\b(broken|degraded|failing|passing|clean|currently|today|right now|no required|not required|bypass(?:es|ed)?)\b/i
  const NEGATIVE_CHECK = /\brequires? (no|none|nothing|zero)\b|\bno (required )?status check\b/i;
  // PAST TENSE is what makes a sentence history, and the verb list is where that
  // is decided -- there is no separate exemption, on purpose.
  //
  // "R-01 was broken on 2026-08-22" is exactly what this document should keep: it
  // says why a rule changed, and a session that cannot read it repeats the
  // investigation. An earlier version rejected it, because it accepted `was` and
  // `were` beside the present-tense verbs and then found `broken` anywhere in the
  // sentence. Dropping those two verbs fixes it at the source.
  //
  // I first fixed it by ADDING a historical exemption -- dates, `previously`,
  // `at the time` -- and stubbing showed it was inert: removing it changed no
  // result, because the verb list had already settled the question. It was also
  // strictly worse than nothing, since it would have spared a live claim that
  // happened to mention a date. Tolerance added is detection subtracted, and an
  // exemption that never fires still widens what gets through.
  const statesRuleOutcome = s => /\bR-\d+\b/.test(s)
    && /\bR-\d+\b[^.]{0,60}?\b(is|are|lets|allows|requires|carries|exempts|declares|reports?|remains?)\b/i.test(s)
    && (RULE_OUTCOME.test(s) || NEGATIVE_CHECK.test(s));

  // `countsRemainingWork` matches a remaining-work CONSTRUCTION, with the
  // qualifier attached to the count rather than merely somewhere in the sentence.
  // Two independent sentence-wide tests rejected "the four PRs are still the
  // programme size", which states a fixed size and is exactly what the
  // neighbouring control claims to spare.
  // An ORDINAL is not by itself a claim about what remains. "The first two PRs
  // landed on 24 Aug" is durable history and the earlier version rejected it,
  // because `first` and `next` were accepted unconditionally -- which pressures an
  // author to delete valid context to get a green run. So an ordinal count has to
  // appear in a construction that actually SAYS the items remain.
  const REMAINS = /\b(remain(s|ing)?|left|outstanding|still to (land|come|do)|to go|not yet)\b/i;
  // COMPLETION puts a count in the past, which is history and not a claim about
  // what is left. I argued that `last` was safe unconditionally, on the reasoning
  // that nothing calls finished work "the last two" -- and "the last two PRs
  // landed on 24 Aug" is precisely that. The reasoning was wrong, and the rule now
  // turns on tense, exactly as the rule-outcome matcher above does.
  //
  // This exemption is load-bearing rather than decorative, which is the thing to
  // check before keeping one: removing it turns both of the sentences below back
  // into offenders, and there is a stub that proves it. An exemption that never
  // fires would be a widened surface waiting for the input that reaches it.
  const COMPLETED = /\b(landed|merged|shipped|completed|closed|went in|finished|are done|were done)\b/i;
  const countsRemainingWork = s =>
    // "The last two PRs of the durable-effect programme." -- a bare heading
    // naming outstanding work, with no verb to place it in time.
    (/\b(last|remaining|final)\s+(one|two|three|four|\d+)\s+(more\s+)?(prs?|pull requests?|stages?)\b/i.test(s)
     && !COMPLETED.test(s))
    // any count, when the sentence says they remain
    || (/\b(first|next|last|one|two|three|four|\d+)\s+(more\s+)?(prs?|pull requests?|stages?)\b/i.test(s)
        && REMAINS.test(s))
    || /\b(prs?|pull requests?|stages?)\s+(remaining|left|outstanding)\b/i.test(s);

  const offenders = [];
  for (const [label, text] of [[HANDOFF, handoff.replace(/^## 0\. STATE[\s\S]*?(?=^## )/m, "")], [PROMPT, prompt]])
    for (const b of blocksOf(text)) {
      const joined = b.lines.join(" ");
      for (const sentence of sentencesOf(joined)) {
        if (/§0/.test(sentence.replace(/\(§0\)/g, ""))) continue;
        const lowerS = sentence.toLowerCase();
        const named = [...commands, ...subjectsInComments].filter(c => CLAIM(c).test(sentence))
          .concat(rowWords
            .filter(([, ws]) => ws.filter(w => new RegExp(`\\b${w}\\b`).test(lowerS)).length >= 4)
            .map(([label]) => `${label} (restated, not named)`));
        if (named.length) offenders.push(`${label}:${b.nums[0]} claims a "${named[0]}" outcome — ${sentence.trim().slice(0, 70)}`);
      }
      // Row LABELS are judged per sentence too, and that is the third time the
      // block-scoped exemption has been the defect rather than the rule.
      //
      // A block that mentions §0 anywhere was exempt in full. That is generous in
      // exactly the wrong direction: the paragraphs most likely to restate a
      // volatile fact are the ones ALREADY discussing it, so they are the ones
      // carrying a §0 pointer. Three findings came from that one allowance -- a
      // doctor outcome, a restated merge rule, and a progress count -- each in a
      // block whose later sentence deferred correctly.
      //
      // The rule is the same one the other two halves already use: the deferral
      // has to be in the same breath as the claim. A sentence that says "see §0"
      // is exempt; the sentence next to it is not.
      for (const sentence of sentencesOf(joined)) {
        if (/§0/.test(sentence.replace(/\(§0\)/g, ""))) continue;
        const lower = sentence.toLowerCase();
        const named = subjects.filter(s => lower.includes(s.toLowerCase()));
        if (named.length) offenders.push(`${label}:${b.nums[0]} names "${named[0]}" — ${sentence.trim().slice(0, 70)}`);

        // Two shapes that recurred and that nothing above could see. Both were
        // found in review AFTER a fix that did not cover them, which is the whole
        // reason they are rules and not resolutions to be careful.

        // A RULE'S OUTCOME. §6 explains what R-01 and R-03 mean; what either
        // currently reports is doctor's answer. A sentence that says an R-number
        // "is" or "lets" or "requires" something has copied that answer, and the
        // copy primes a reader to treat real drift as the finding they expected.
        if (statesRuleOutcome(sentence))
          offenders.push(`${label}:${b.nums[0]} states an R-rule's OUTCOME — ${sentence.trim().slice(0, 70)}`);

        // A COUNT OF REMAINING WORK. "The last two PRs" is true until one lands
        // and then silently sequences a session onto work that is done. §0 says
        // which stages remain; a number here is a second copy of that.
        if (countsRemainingWork(sentence))
          offenders.push(`${label}:${b.nums[0]} counts REMAINING work — ${sentence.trim().slice(0, 70)}`);
      }
    }
  check(offenders.length === 0, "no block outside §0 names a §0 subject without deferring to it",
    offenders.slice(0, 4).join("\n        "));

  // Controls, because both rules above are regexes over prose and a regex that
  // stopped matching would read exactly like documents that stopped offending.
  // Both directions, and the SPARING half matters more: these documents are
  // required to explain what each rule means and how large the programme is, so a
  // matcher that rejects durable statements does not merely annoy -- it pushes the
  // explanation out of the document that exists to carry it.
  for (const [what, sample, want] of [
    ["an R-rule outcome", "R-01 is currently broken and lets admins bypass every rule.", true],
    ["an R-rule outcome in other words", "R-01 reports degraded today.", true],
    ["a remaining-work count", "The last two PRs of the programme remain.", true],
    ["a remaining-work count phrased the other way round", "Two stages still remain.", true],
    ["a rule's MEANING, which is durable", "R-01 means reeve must stand as a required check.", false],
    ["a rule DEFINED with an ordinary verb", "R-01 is the merge-authority check.", false],
    ["a rule's requirement, which does not expire", "R-01 requires a status check to exist.", false],
    ["the programme's own size, which does not change", "§3.2 lists all four PRs of the plan.", false],
    ["a fixed size stated with an unrelated qualifier", "The four PRs are still the programme size.", false],
    ["a negative status-check claim", "R-01 requires no status check.", true],
    ["dated history, which this document exists to keep", "R-01 was broken on 2026-08-22.", false],
    ["past-tense history with no date", "R-03 was previously degraded.", false],
    ["a LIVE claim that happens to mention a date", "R-01 is currently broken, as on 2026-08-22.", true],
    ["an ordinal in durable history", "The first two PRs landed on 24 Aug.", false],
    ["an ordinal that DOES say work remains", "The first two PRs are still outstanding.", true],
    ["a LAST-count in durable history", "The last two PRs landed on 24 Aug.", false],
    ["a FINAL-count in durable history", "The final two stages landed together.", false],
    ["a bare heading naming outstanding work", "The last two PRs of the durable-effect programme.", true],
  ]) check((statesRuleOutcome(sample) || countsRemainingWork(sample)) === want,
           `control: the state-claim rules ${want ? "catch" : "spare"} ${what}`, sample);

  // A sentence ending inside a LINK still splits, so a claim cannot hide behind
  // URL syntax the way it hid behind bold.
  check(sentencesOf("[doctor reports degraded.](d/e.md) See §0.1").length === 2,
    "control: a sentence ending inside a markdown link is still two sentences",
    JSON.stringify(sentencesOf("[doctor reports degraded.](d/e.md) See §0.1")));
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
