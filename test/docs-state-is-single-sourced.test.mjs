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

// Present-tense claims about state. Deliberately NOT a SHA match: the prompt
// legitimately cites commits for WHEN a thing landed, which is history and does
// not go stale.
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

/** Lines making a present-tense state claim without pointing at §0. A pointer may
 * wrap, so the reference counts if it is within two lines either way. */
const offendersIn = text => {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!STATE_CLAIMS.some(re => re.test(lines[i]))) continue;
    const window = lines.slice(Math.max(0, i - 2), i + 3).join(" ");
    if (!/§0/.test(window)) out.push(`${i + 1}: ${lines[i].trim().slice(0, 88)}`);
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
