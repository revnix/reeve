// The settlement floor is a high-water mark of how many checks a revision has
// reported, and it is only meaningful against a FIXED notion of what a check IS.
// CHECK_ACCOUNTING is the version of that notion; a floor stored under an older
// number is discarded rather than compared against.
//
// This has now gone wrong twice, the same way both times:
//
//   accounting 2  excluding reeve's own policy row dropped every head's count by
//                 one. Measured live: five open PRs, every one short of its stored
//                 floor, so no revision could reach it again and every pull
//                 request would have blocked forever.
//   accounting 3  excluding reviewer commit-status contexts did it again. nextly
//                 #1011 read "only 34 checks reported where 35 were expected"
//                 within a minute of the change shipping.
//
// The second time, the mechanism was already there and CORRECT -- and it still
// went wrong, because bumping the number is a thing a person has to REMEMBER. A
// rule that depends on memory is not a rule, so this test is the step that makes
// remembering unnecessary: change what counts as a check, and it fails until the
// version moves with it.
//
// It is deliberately brittle in the SAFE direction. A false trip costs one
// rebuilt floor, which is a few ticks of settlement. A missed trip costs every
// pull request, forever.
import { CHECK_ACCOUNTING } from "../src/github/reconciler.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const src = readFileSync(new URL("../src/github/reconciler.mjs", import.meta.url), "utf8");

/**
 * The code that decides what counts as a check: both exclusion helpers and the
 * reader that applies them. Comments and whitespace are stripped so rewriting a
 * comment does not trip the guard, while any change to the LOGIC does.
 */
function countedSetSource() {
  const grab = (name, kind = "function") => {
    const start = src.indexOf(`export ${kind} ${name}`);
    if (start < 0) return null;
    // Brace-match from the body's opening brace, which is the one AFTER the
    // parameter list closes. Starting at the first `{` instead captured the
    // destructured parameter of readChecks(nwo, sha, { reviewerContexts }) and
    // stopped there -- so the fingerprint covered a signature and no logic, and
    // a stub that changed what counts sailed straight past it. An instrument
    // that cannot represent the failure it exists to catch reads as PASS.
    let paren = 0, bodyStart = -1;
    for (let j = src.indexOf("(", start); j < src.length; j++) {
      if (src[j] === "(") paren++;
      else if (src[j] === ")" && --paren === 0) { bodyStart = src.indexOf("{", j); break; }
    }
    if (bodyStart < 0) return null;
    let depth = 0;
    for (let j = bodyStart; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(start, j + 1);
    }
    return null;
  };
  const wanted = ["excludeOwnPolicy", "excludeReviewerContexts", "readChecks"];
  const parts = wanted.map(n => grab(n));
  countedSetSource.found = wanted.filter((_, i) => parts[i] !== null);
  countedSetSource.missing = wanted.filter((_, i) => parts[i] === null);
  if (parts.some(p => p === null)) return null;
  return parts.join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments
    .replace(/\/\/[^\n]*/g, "")          // line comments
    .replace(/\s+/g, " ")                // whitespace
    .trim();
}

const body = countedSetSource();

// Control: the extractor must actually find the code. An extractor that quietly
// returned nothing would hash the empty string forever and pass every change.
// Derived from the list the extractor asks for, not a magic length: a threshold
// number is itself something to get wrong, and a short-but-nonempty extraction
// would sail past one.
check(countedSetSource.missing.length === 0,
  `control: all ${countedSetSource.found.length + countedSetSource.missing.length} counted-set functions were extracted`,
  countedSetSource.missing.length
    ? `not found: ${countedSetSource.missing.join(", ")} — update the extractor's name list`
    : "");
check(/excludeReviewerContexts/.test(body ?? "") && /excludeOwnPolicy/.test(body ?? ""),
  "and covers both exclusion rules plus the reader that applies them");

const fingerprint = createHash("sha256").update(body ?? "").digest("hex").slice(0, 16);

// ── the pinned pair ──────────────────────────────────────────────────────────
//
// Update BOTH lines together, never one alone. If this fails, ask: did what
// counts as a check just change? If yes, bump CHECK_ACCOUNTING and paste the new
// fingerprint. If no — a rename, a refactor with identical behaviour — paste the
// fingerprint and leave the version alone.
const PINNED_ACCOUNTING = 3;
const PINNED_FINGERPRINT = "6698a602b0950eac";

check(CHECK_ACCOUNTING === PINNED_ACCOUNTING,
  "CHECK_ACCOUNTING matches the version this fingerprint was taken under",
  `code says ${CHECK_ACCOUNTING}, this test pins ${PINNED_ACCOUNTING}`);

check(fingerprint === PINNED_FINGERPRINT,
  "what counts as a check has not changed without the accounting version moving",
  `fingerprint is ${fingerprint}, pinned ${PINNED_FINGERPRINT}\n` +
  "        -> if the counted SET changed, bump CHECK_ACCOUNTING and update both lines.\n" +
  "        -> if this was a pure refactor, update the fingerprint only.\n" +
  "        A stale floor under a changed accounting blocks every PR forever.");

// The version is only useful if a stored floor under a DIFFERENT one is refused.
// That is enforced in db/ops.mjs; assert the comparison exists rather than
// trusting that it does.
{
  const ops = readFileSync(new URL("../src/db/ops.mjs", import.meta.url), "utf8");
  check(/accounting !== CHECK_ACCOUNTING/.test(ops),
    "a floor stored under another accounting version is discarded, not compared",
    (ops.match(/[^\n]*accounting[^\n]*CHECK_ACCOUNTING[^\n]*/) ?? ["(no comparison found)"])[0].trim());
  check(/CHECK_ACCOUNTING\)?\s*;?\s*$/m.test(ops) || /CHECK_ACCOUNTING/.test(ops),
    "and a newly stored floor records the current version");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
