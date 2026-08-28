// Every worker prompt ends by asking for a fenced json block: what was wrong,
// what changed, whether a test was written, and `needsHuman` if the work belongs
// to a person. That block was written into every prompt and parsed by NOTHING.
//
// Measured on revnix/reeve PR #2, run 16. A failure was planted in
// src/verdict.mjs, which is a sensitive path, so the worker did exactly what
// rule 8 tells it to: it stopped and reported why. reeve threw the reason away
// and pushed this to a phone:
//
//   #2: a fix was produced but refused publication
//       — the worker produced an empty diff — nothing was changed
//
// Two statements that cannot both be true, about a worker that behaved correctly.
// On the next tick the retry cap fired and replaced it with "the same failure
// survived a second fix" -- and since a clearing retires the earlier one, the
// ONLY message left standing was the one claiming a fix had been tried. No fix
// was ever attempted.
//
// The report is trusted for one question and one only: WHY did you stop. Whether
// anything was fixed is answered by git and by CI, because the actor is never the
// witness. But nothing else witnesses a worker's reason for stopping.
import { parseReport, statedBlocker } from "../src/supervisor.mjs";
import { open, recordFixAttempt, fixAttemptNote, countFixAttempts } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// The shape a real declining worker produces, prose and all.
const REAL = `I looked at the failing assertions and traced them to the pair rule in
src/verdict.mjs. Fixing it means editing that file, which the rules list as
sensitive, so I have stopped rather than changing it.

\`\`\`json
{
  "fixed": false,
  "cause": "the worst-wins rule was changed so a single UNKNOWN no longer wins",
  "change": "nothing — the fix belongs in a sensitive path",
  "test": {"added": false, "failedBefore": true, "passedAfter": false, "command": "node test/verdict.test.mjs"},
  "needsHuman": "the fix is a one-character change in src/verdict.mjs, a sensitive path",
  "filesTouched": [],
  "committed": false,
  "commit": null
}
\`\`\``;

const r = parseReport(REAL);
check(!!r, "control: a real worker's answer parses at all", JSON.stringify(r));
check(r?.fixed === false, "and carries the fixed flag");
check(/sensitive path/.test(statedBlocker(r) ?? ""),
  "and the reason it stopped, which is what a human needs", statedBlocker(r));

// A worker that quotes the shape before answering must not have the EXAMPLE read
// as its answer. The prompt itself contains a json block, so this is the norm.
const quoted = "I will finish with:\n```json\n{\"fixed\": true|false}\n```\nHere is my answer:\n" +
  "```json\n{\"fixed\": true, \"needsHuman\": false}\n```";
check(parseReport(quoted)?.fixed === true,
  "the LAST valid block is the answer, not an earlier example", JSON.stringify(parseReport(quoted)));

// A malformed earlier block must not defeat a good later one, nor vice versa.
check(parseReport("```json\n{not json}\n```\n```json\n{\"fixed\": false}\n```")?.fixed === false,
  "a malformed block is skipped rather than fatal");
check(parseReport("no json here at all") === null, "and prose with no block is simply null");
check(parseReport(undefined) === null, "as is a worker that returned nothing");

// `needsHuman` is `false | "why"`. A bare true carries no reason and must not be
// rendered to a human as one.
check(statedBlocker({ needsHuman: false }) === null, "needsHuman false is not a blocker");
check(statedBlocker({ needsHuman: true }) === null, "and a bare true is not a reason", "true");
check(statedBlocker({ needsHuman: "   " }) === null, "nor is whitespace");
check(statedBlocker(null) === null, "and no report at all is not a blocker");

// ── the reason survives to the escalation after the cap ──────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-report-"));
  const db = open(join(dir, "s.db"));
  const CAUSE = "revnix/reeve::CI Gate::x";

  recordFixAttempt(db, "revnix/reeve", 2, CAUSE, "abc123", 1, statedBlocker(r));
  check(fixAttemptNote(db, "revnix/reeve", 2, CAUSE) === statedBlocker(r),
    "the reason is carried on the ledger row the retry cap reads",
    fixAttemptNote(db, "revnix/reeve", 2, CAUSE));

  // A later attempt that says nothing must not erase what the last one said --
  // otherwise the cap fires with the reason already forgotten.
  recordFixAttempt(db, "revnix/reeve", 2, CAUSE, "def456", 2, null);
  check(countFixAttempts(db, "revnix/reeve", 2, CAUSE) === 2, "attempts still count");
  check(fixAttemptNote(db, "revnix/reeve", 2, CAUSE) === statedBlocker(r),
    "and a silent later attempt does not erase the reason",
    fixAttemptNote(db, "revnix/reeve", 2, CAUSE));

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// ── the wiring ───────────────────────────────────────────────────────────────
//
// Every piece above is inert unless the daemon reads the report off the result
// and passes the reason on. Asserted directly: the parse defaults to null, and
// null is silently indistinguishable from a worker that said nothing.
{
  const src = await import("node:fs").then(m =>
    m.readFileSync(new URL("../src/daemon.mjs", import.meta.url), "utf8"));

  // Named by SITE, not by symbol. A guard matching only "statedBlocker(r.report)"
  // passed while the escalation site was stubbed out, because the ledger site
  // still matched -- a check whose input narrowed, reporting success.
  check(/const blocker = statedBlocker\(r\.report\)/.test(src),
    "the escalation site reads the worker's stated blocker",
    (src.match(/const blocker = [^;]*/) ?? ["(no such assignment)"])[0]);
  check(/needs a human — \$\{blocker\}/.test(src),
    "and puts it in the message a human actually receives");
  // FILED UNDER THE SAME IDENTITY IT WAS SPENT AGAINST, which is the invariant;
  // the literal call text below is only its current spelling. The blocker used to
  // be stored under the CI fingerprint alone, so a FIX_FINDINGS worker that said
  // it needed a human had its reason recorded where no reader could find it, and
  // the useful escalation was replaced next tick by a generic capped cause.
  check(/recordFixAttempt\)\(db, nwo, e\.pr, spendKey,/.test(src) &&
        /noteFixAttempt\(db, nwo, e\.pr, spendKey,/.test(src),
    "and files it under the same key the attempt was spent against",
    (src.match(/noteFixAttempt\([^;]*/) ?? ["(no call)"])[0]);
  // AND READS IT BACK ONLY FOR THE ESCALATION IT BELONGS TO.
  //
  // Two repairs each store a blocker under their own identity. Consulting
  // whichever happened to be non-null meant a stale findings note displaced the
  // real reason on any higher-priority escalation that came later — a conflicted
  // branch, an unreadable review body — so the operator saw a blocker from a
  // different problem and reconciliation treated the actual one as absent.
  check(/decision\.why === ESCALATIONS\.REPEATED_FAILURE && fp/.test(src),
    "the CI note is consulted only for the CI escalation",
    (src.match(/const note = [\s\S]{0,200}/) ?? ["(no lookup)"])[0]);
  check(/decision\.why === ESCALATIONS\.FINDINGS_UNMOVED && ffp/.test(src),
    "and the findings note only for the findings one");
  // Control: an unguarded lookup is what this replaced, so the shape that would
  // reintroduce it must not be present.
  check(!/const note = \(fp \? fixAttemptNote/.test(src),
    "control: the unguarded fallback that displaced the real blocker is gone");
  // Attached AFTER the worker speaks, not at dispatch: the attempt is spent
  // before any worker exists, and reading a not-yet-assigned result there threw
  // a ReferenceError on every FIX_CI.
  check(/noteFixAttempt\(db, nwo, e\.pr, spendKey, statedBlocker\(r\.report\)\)/.test(src),
    "and attaches it to the fix attempt once the worker has spoken",
    (src.match(/noteFixAttempt\([^;]*/) ?? ["(no call found)"])[0]);
  check(!/recordFixAttempt\([\s\S]{0,140}?statedBlocker/.test(src),
    "and never reads the worker's report at dispatch, where it does not exist yet",
    (src.match(/recordFixAttempt\([^;]*/) ?? [""])[0]);
  check(/fixAttemptNote\(/.test(src),
    "and reads it back when the retry cap escalates");

  const sup = await import("node:fs").then(m =>
    m.readFileSync(new URL("../src/supervisor.mjs", import.meta.url), "utf8"));
  check(/report: parseReport\(result\.result\)/.test(sup),
    "and the supervisor puts it on the result in the first place");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
