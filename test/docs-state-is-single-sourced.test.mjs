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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const docs = join(here, "..", "docs");

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const PROMPT = "2026-08-23-resume-prompt.md";
const HANDOFF = "2026-08-23-session-handoff.md";
const prompt = readFileSync(join(docs, PROMPT), "utf8");
const handoff = readFileSync(join(docs, HANDOFF), "utf8");

// Present-tense claims about state. Deliberately NOT a SHA match: the prompt
// legitimately cites commits for WHEN a thing landed, which is history and does
// not go stale.
const STATE_CLAIMS = [
  /\bis open\b/i, /\bstill open\b/i, /\bcurrently open\b/i, /\bremaining work\b/i,
  /\bis armed\b/i, /\bis disarmed\b/i, /\bawaiting review\b/i, /\bnot yet merged\b/i,
];

// --- the prompt states no current facts except as a pointer ------------------
{
  const lines = prompt.split("\n");
  const offenders = [];
  for (let i = 0; i < lines.length; i++) {
    if (!STATE_CLAIMS.some(re => re.test(lines[i]))) continue;
    // A pointer may wrap: the reference can be on this line or the next two.
    const window = lines.slice(i, i + 3).join(" ");
    if (!/§0/.test(window)) offenders.push(`${i + 1}: ${lines[i].trim().slice(0, 90)}`);
  }
  check(offenders.length === 0,
    `${PROMPT} states no current facts except as a §0 pointer`,
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
  check(/change them HERE and nowhere else/i.test(zero),
    "§0 states the rule that keeps it single-sourced", zero.slice(0, 120));
  // And it must actually carry the volatile facts, or the pointers point at nothing.
  for (const fact of [/`main`/, /--execute/, /merged/])
    check(fact.test(zero), `§0 carries the fact matching ${fact}`, "");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
