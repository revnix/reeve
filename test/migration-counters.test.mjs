/**
 * The legacy migration's two counters are keyed by UNTRUSTED INPUT, and this is
 * the assertion that they still count what they are given.
 *
 * `report.unknownKind` and `report.coercedStatus` are keyed by `ev.kind` and
 * `ev.status` read straight out of the legacy JSONL. A value only reaches a
 * counter BECAUSE it is not in KIND or STATUS, so the key set is by construction
 * whatever the file happens to carry -- never a value this codebase chose.
 *
 * WHY THE FAILURE MODE MATTERS, and why it needed a test rather than a comment.
 * On a plain object the two names below do different wrong things and NEITHER
 * throws:
 *
 *   `o["__proto__"] = n` invokes the inherited SETTER instead of creating a
 *   property. The key never appears in `Object.keys`, so the count is lost and
 *   the report says the value was never seen.
 *
 *   `o["constructor"]`, and every other Object.prototype name, reads back as the
 *   inherited FUNCTION, so `(o[k] || 0) + 1` stringifies it. The report then
 *   prints `"constructor": "function Object() { [native code] }1"`.
 *
 * The second is worse than the first. The counters exist so a human can decide
 * whether a legacy import dropped anything; a lost count reads as "clean", and a
 * garbage count reads as neither clean nor broken. Both are failures of the
 * evidence rather than of the write -- the node is still inserted with the
 * coerced value either way -- which is exactly why nothing else notices.
 *
 * MEASURED AGAINST THE UNFIXED CODE, not reasoned about. The same fixture run
 * against the pre-fix migration produced:
 *
 *   "coercedStatus": { "valueOf": "function valueOf() { [native code] }1" }
 *   "unknownKind":   { "constructor": "function Object() { [native code] }1",
 *                      "toString":    "function toString() { [native code] }1",
 *                      "nonsense":    1 }
 *
 * -- both `__proto__` entries gone, three counts replaced by strings. That is the
 * red this test must produce if the null prototype is ever removed.
 *
 * SPAWNED rather than imported, because `src/db/migrate.mjs` is a top-level
 * script: it reads `process.argv`, deletes the target database and exports
 * nothing. The report on stdout is its whole interface, and it is what a human
 * reads, so it is the right thing to assert against.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// Every name here is one a plain object mishandles, plus one ordinary value that
// it handles correctly. The ordinary one is the control: it counts to 1 whether
// or not the fix is present, so an assertion that only ever looked at it would
// pass over the broken code.
const HOSTILE = ["__proto__", "constructor", "toString", "hasOwnProperty"];
const ORDINARY = "nonsense";

const dir = mkdtempSync(join(tmpdir(), "reeve-migration-counters-"));
try {
  const lines = [];
  let n = 0;
  for (const kind of [...HOSTILE, ORDINARY])
    lines.push(JSON.stringify({ op: "add", id: `k${++n}`, kind, title: kind, at: "2026-01-01T00:00:00Z" }));
  for (const status of [...HOSTILE, ORDINARY])
    lines.push(JSON.stringify({ op: "add", id: `s${++n}`, kind: "task", status, title: status, at: "2026-01-01T00:00:00Z" }));
  const jsonl = join(dir, "legacy.jsonl");
  writeFileSync(jsonl, lines.join("\n") + "\n");

  const out = execFileSync(process.execPath,
    [join(REPO, "src", "db", "migrate.mjs"), jsonl, join(dir, "hub.db")],
    { encoding: "utf8", cwd: REPO });

  // ── Controls, before any assertion about a counter ────────────────────────
  //
  // The report is the FIRST JSON object on stdout; everything after it is the
  // script's own summary lines. A migration that failed would print none of it,
  // and every assertion below would then be reading `undefined` -- which is the
  // shape that passes for a reason unrelated to what it claims.
  let report = null;
  try { report = JSON.parse(out.slice(0, out.indexOf("\n}") + 2)); } catch { /* left null */ }
  check(report !== null, "control: the migration ran and printed a parseable report",
    out.slice(0, 200));
  if (report === null) { console.log(`\nfailed=${++fail}`); process.exitCode = 1; }
  else {
    check(report.lines === lines.length,
      "control: and it read every fixture line -- a short read would make the counts below vacuous",
      `read ${report.lines} of ${lines.length}`);
    check(report.unknownKind?.[ORDINARY] === 1 && report.coercedStatus?.[ORDINARY] === 1,
      "control: an ORDINARY unknown name counts to 1 in both counters, so the fixture reaches them at all",
      JSON.stringify({ kind: report.unknownKind?.[ORDINARY], status: report.coercedStatus?.[ORDINARY] }));

    // ── The property itself ───────────────────────────────────────────────────
    for (const name of HOSTILE) {
      // `Object.hasOwn` rather than a truthiness read: on a plain object
      // `report.unknownKind.constructor` is truthy while the count is a garbage
      // string, so a truthiness check would pass over the exact defect this
      // guards. Presence and value are asserted separately for the same reason.
      check(Object.hasOwn(report.unknownKind, name),
        `an unknown kind named '${name}' is PRESENT in unknownKind`,
        JSON.stringify(report.unknownKind));
      check(report.unknownKind[name] === 1,
        `'${name}' counts to the NUMBER 1 in unknownKind, not a stringified inherited function`,
        JSON.stringify(report.unknownKind[name]));
      check(Object.hasOwn(report.coercedStatus, name),
        `a coerced status named '${name}' is PRESENT in coercedStatus`,
        JSON.stringify(report.coercedStatus));
      check(report.coercedStatus[name] === 1,
        `'${name}' counts to the NUMBER 1 in coercedStatus too`,
        JSON.stringify(report.coercedStatus[name]));
    }

    check(Object.keys(report.unknownKind).length === HOSTILE.length + 1,
      "and the counter holds every name it was given and nothing else",
      JSON.stringify(Object.keys(report.unknownKind)));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exitCode = fail ? 1 : 0;
