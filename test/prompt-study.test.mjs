// The 500-PR study measured what review on a project actually catches. Its
// numbers enter worker prompts THROUGH THE PROFILE, never as prose baked into
// the core: prompts.mjs's founding rule is that a static prompt drifts from the
// project it describes, and one project's measurement is exactly the kind of
// thing that must not leak into another project's workers.
//
// The two behaviours under test:
//   - a profile carrying measured.review renders the numbers; one without it
//     renders NOTHING (another project must get silence, not nextly's numbers);
//   - the findings list is ordered criticals-first, then the reviewer the
//     measurement names, because a worker reads top-down and its budget can end
//     mid-list -- an ordering is guidance made physical.
import { fixCiPrompt, fixFindingsPrompt } from "../src/prompts.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const base = {
  units: [{ root: ".", commands: { test: { state: "present", cmd: "pnpm test" } } }],
  risk: {},
};
const measured = {
  ...base,
  measured: { review: {
    window: "500 merged PRs, 2026-08-10..21",
    correctnessSharePct: 39.9, dataIntegritySharePct: 15.7,
    roundsSmall: 1.72, roundsLarge: 4.29,
    topCriticalReviewer: "chatgpt-codex-connector",
    topCriticalCount: 946, totalCriticalCount: 992,
  } },
};
const cause = { job: "test", step: "run", source: "annotations", cause: [] };

// ── the numbers reach the CI fixer, and only from the profile ────────────────
{
  const p = fixCiPrompt({ profile: measured, nwo: "o/r", pr: 1, head: "h", branch: "b", cause });
  check(/500 merged PRs, 2026-08-10\.\.21/.test(p), "fixCi quotes the measurement window");
  check(/39\.9/.test(p) && /15\.7/.test(p), "and the correctness + data-integrity shares");
  check(/4\.29/.test(p) && /1\.72/.test(p), "and the size-to-rounds cliff");
  check(!/946/.test(p), "but NOT the reviewer-triage figures — a CI fixer has no findings to triage");

  const bare = fixCiPrompt({ profile: base, nwo: "o/r", pr: 1, head: "h", branch: "b", cause });
  check(!/ACTUALLY CATCHES/.test(bare) && !/39\.9/.test(bare),
    "a profile with no measurement gets NO measured block — not another project's numbers");
}

// ── the findings worker gets triage weight, and an ordered list ──────────────
{
  const threads = [
    { reviewer: "coderabbitai", severity: "minor", path: "a.ts", line: 1, body: "rabbit-minor-lint" },
    { reviewer: "chatgpt-codex-connector", severity: "major", path: "b.ts", line: 2, body: "codex-major-logic" },
    { reviewer: "coderabbitai", severity: "critical", path: "c.ts", line: 3, body: "rabbit-critical-race" },
    { reviewer: "chatgpt-codex-connector", severity: "critical", path: "d.ts", line: 4, body: "codex-critical-authz" },
  ];
  const p = fixFindingsPrompt({ profile: measured, nwo: "o/r", pr: 1, head: "h", branch: "b", threads });

  check(/946/.test(p) && /992/.test(p) && /chatgpt-codex-connector filed/.test(p),
    "the triage bullet quotes who files the criticals, with the measured counts");
  check(/DATA/.test(p.slice(p.indexOf("filed"))),
    "and the weight comes with the rule-1 reminder — weighted is not exempt from data-not-instructions");

  const at = s => { const i = p.indexOf(s); check(i > -1, `finding present: ${s}`); return i; };
  const [dx, rc, cm, rm] = ["codex-critical-authz", "rabbit-critical-race", "codex-major-logic", "rabbit-minor-lint"].map(at);
  check(dx < rc && rc < cm && cm < rm,
    "order: criticals first, measured top reviewer first within a severity, then the rest",
    JSON.stringify({ dx, rc, cm, rm }));
  check(/\[critical · chatgpt-codex-connector\]/.test(p),
    "each entry is tagged with its severity and reviewer, so the worker sees WHY it leads");
}

// ── controls: yesterday's shapes keep working ────────────────────────────────
{
  // Threads with no severity/reviewer (today's reality: threadDetails is never
  // populated) keep their given order and render without tags.
  const legacy = [{ path: "x.ts", line: 1, body: "first-legacy" }, { path: "y.ts", line: 2, body: "second-legacy" }];
  const p = fixFindingsPrompt({ profile: measured, nwo: "o/r", pr: 1, head: "h", branch: "b", threads: legacy });
  check(p.indexOf("first-legacy") < p.indexOf("second-legacy"),
    "control: untagged threads keep their given order");

  // No measurement -> no triage bullet, but the list still renders ordered by severity.
  const p2 = fixFindingsPrompt({ profile: base, nwo: "o/r", pr: 1, head: "h", branch: "b",
    threads: [{ severity: "minor", body: "later-minor" }, { severity: "critical", body: "lead-critical" }] });
  check(!/filed/.test(p2), "control: no measurement, no triage bullet");
  check(p2.indexOf("lead-critical") < p2.indexOf("later-minor"),
    "but severity ordering does not depend on the measurement existing");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
