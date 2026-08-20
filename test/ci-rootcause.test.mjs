// Root-cause tiering and the log-window parse. Both were wrong on first write and
// both are cheap to get wrong again.
import { isActionable, salientLines, fingerprint, parseLogStamp } from "../src/ci-rootcause.mjs";

let fail = 0;
const check = (n, got, want) => { const ok = got === want;
  console.log(`${ok ? "PASS" : "FAIL"}  ${n}`); if (!ok) { console.log(`        got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); fail++; } };

// ── the timestamp ─────────────────────────────────────────────────────────
const LINE = "2026-08-20T04:57:56.9200172Z ✖ .changeset/x.md: missing 1 of 25";

// The bug: slicing a fixed 24 chars drops the Z, so this parses as LOCAL time.
// On a +05:00 machine that is five hours early and every step window misses.
check("a log stamp parses as UTC", new Date(parseLogStamp(LINE)).toISOString(), "2026-08-20T04:57:56.920Z");
check("the naive fixed slice is NOT used", Date.parse(LINE.slice(0, 24)) === parseLogStamp(LINE), false);
check("a line with no stamp is NaN", Number.isNaN(parseLogStamp("no timestamp here")), true);
check("a stamp needs the trailing Z", Number.isNaN(parseLogStamp("2026-08-20T04:57:56.920 no-z")), true);

// ── tiering ───────────────────────────────────────────────────────────────
// A generic runner message means the cause is in the log, not the annotation.
check("the generic exit message is not actionable", isActionable("Process completed with exit code 1."), false);
check("without the full stop either", isActionable("Process completed with exit code 137"), false);
check("a cancellation is not actionable", isActionable("The job was cancelled"), false);
check("an empty message is not actionable", isActionable(""), false);
check("a real test failure IS actionable",
  isActionable("2) [chromium] › exit-demo.spec.ts:25:3 › a builder-authored page…"), true);
check("a compiler error IS actionable", isActionable("TS2345: Argument of type 'string'…"), true);

// ── salience ──────────────────────────────────────────────────────────────
{
  const text = [
    "> nextly@ test",
    "  ✓ some passing test",
    "✖ .changeset/canvas-undo.md: missing 1 of 25 lockstep packages — @nextlyhq/eslint-plugin.",
    "  more noise",
    "##[error]Process completed with exit code 1.",
  ].join("\n");
  const hits = salientLines(text);
  check("the failing line is picked out", hits.some(h => h.includes("missing 1 of 25")), true);
  check("the error marker is picked out", hits.some(h => h.startsWith("##[error]")), true);
  check("passing noise is not", hits.some(h => h.includes("some passing test")), false);
}

// ── fingerprint ───────────────────────────────────────────────────────────
{
  const a = { job: "Browser tests", step: "Run browser tests", cause: [{ where: "a.spec.ts:1", message: "boom" }] };
  const b = { job: "Browser tests", step: "Run browser tests", cause: [{ where: "a.spec.ts:1", message: "boom" }] };
  const c = { job: "Browser tests", step: "Run browser tests", cause: [{ where: "b.spec.ts:9", message: "other" }] };
  check("the same failure fingerprints the same", fingerprint("o/r", "abc1234567", a) === fingerprint("o/r", "abc1234567", b), true);
  check("a different failure fingerprints differently", fingerprint("o/r", "abc1234567", a) === fingerprint("o/r", "abc1234567", c), false);
  // The sha is in the key: the same failure at a new head is a NEW attempt, not a
  // repeat, so a fix that moved the head is not counted against the retry cap.
  check("a new revision fingerprints differently", fingerprint("o/r", "abc1234567", a) === fingerprint("o/r", "def7654321", a), false);
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
