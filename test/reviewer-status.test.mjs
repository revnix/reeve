// PR-1 of the review-ingest plan: four defects that are live TODAY, independent
// of any new ingest. Each was found by auditing the review surfaces against real
// GitHub data on 2026-08-21, and each fails OPEN.
//
//  F-1 A reviewer's commit status counted as a passing CI check. CodeRabbit
//      reports state=success with the truth in the description -- measured as
//      "Review rate limited" on 8 of 9 sampled final heads, and in a second shape
//      as "Review completed" for a path-filter SKIP that read no file at all.
//      readChecks carried the description PRECISELY because the truth hides there
//      and nothing ever read it.
//  F-2 NOT_INSTALLED was consumed by the verdict and never produced, so a
//      rostered-but-absent blocking reviewer read "not yet run" forever instead of
//      reaching REVIEWERS_DOWN.
//  F-3 A refusal was detected only as the LAST comment, so any later chatter from
//      the same reviewer made it invisible -- and both bots comment constantly.
//  F-6 watch.staleSeconds had no default, and an unset staleness bound is an
//      infinite one.
import { excludeReviewerContexts, readChecks, classify } from "../src/github/reconciler.mjs";
import { readReviewerStates } from "../src/pr.mjs";
import { withDefaults, validate } from "../src/profile/schema.mjs";
import { readFileSync } from "node:fs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// ── F-1: a reviewer's status is not CI evidence ──────────────────────────────
{
  // The exact shape measured on nextly #1128's head 34952fb.
  const rateLimited = { name: "CodeRabbit", source: "status", state: "completed",
                        conclusion: "success", description: "Review rate limited" };
  const skipped = { name: "CodeRabbit", source: "status", state: "completed",
                    conclusion: "success", description: "Review completed" };
  const realCi = { name: "Lint / Typecheck / Test / Build", source: "check_run",
                   state: "completed", conclusion: "success", id: "1" };

  // Control: the fixture must be able to exhibit the defect. Unfiltered, the
  // rate-limited reviewer row is indistinguishable from a passing check.
  const before = classify([rateLimited, realCi], ["CodeRabbit"]);
  check(before.verdict === "GREEN",
    "control: unfiltered, a rate-limited reviewer classifies as a passing REQUIRED check",
    JSON.stringify(before.verdict));

  const { rows, reviewerRows } = excludeReviewerContexts([rateLimited, realCi], ["CodeRabbit"]);
  check(rows.length === 1 && rows[0].source === "check_run",
    "the reviewer row is removed from what CI classification sees", JSON.stringify(rows.map(r => r.name)));
  check(reviewerRows.length === 1,
    "and RETURNED rather than dropped — the review pipeline needs it to say 'refused'",
    JSON.stringify(reviewerRows.map(r => r.description)));

  // Both fail-green shapes go, and the rule is categorical: it does not read the
  // description at all, so a third wording the vendor invents cannot defeat it.
  check(excludeReviewerContexts([skipped], ["CodeRabbit"]).rows.length === 0,
    "the 'Review completed' skip shape is excluded too, without reading the text");

  // A required check that is genuinely absent must still be MISSING_REQUIRED, not
  // green: excluding the reviewer row must not excuse its own requirement.
  const after = classify(rows, ["CodeRabbit", "Lint / Typecheck / Test / Build"]);
  check(after.verdict === "MISSING_REQUIRED",
    "a reviewer context named as required is MISSING once excluded, never green",
    JSON.stringify(after.verdict));

  check(excludeReviewerContexts([rateLimited, realCi], []).rows.length === 2,
    "with no contexts configured nothing is excluded — the key is opt-in per project");
}

// ── F-1 wiring: no caller can forget ─────────────────────────────────────────
//
// The exclusion lives inside readChecks beside excludeOwnPolicy, for the same
// stated reason: the BASE head is read through the same function, and a caller
// that forgot would reintroduce the fail-open silently.
{
  const rc = readFileSync(new URL("../src/github/reconciler.mjs", import.meta.url), "utf8");
  const pr = readFileSync(new URL("../src/pr.mjs", import.meta.url), "utf8");

  check(/readChecks\(nwo, sha, \{ reviewerContexts/.test(rc),
    "control: readChecks accepts reviewer contexts",
    (rc.match(/export function readChecks[^\n]*/) ?? ["(not found)"])[0]);
  check(/excludeReviewerContexts\(own\.rows, reviewerContexts\)/.test(rc),
    "and applies them inside readChecks, not at each caller");

  // Every production call site must supply them. A bare readChecks(nwo, sha)
  // defaults to no contexts, and that default is the fail-open returning.
  const bare = [...pr.matchAll(/readChecks\((?![^)]*reviewerContexts)[^)]*\)/g)].map(m => m[0]);
  check(bare.length === 0,
    "every readChecks call in pr.mjs supplies reviewerContexts", bare.join(" | "));
  const baseRead = (rc.match(/const readBase = [^;]*/) ?? [""])[0];
  check(/reviewerContexts/.test(baseRead),
    "and the BASE read does too — the head and its base must be judged alike", baseRead);
}

// ── F-2: NOT_INSTALLED is produced ───────────────────────────────────────────
{
  const roster = [{ login: "codex", kind: "blocking", refusal: "cannot review" },
                  { login: "coderabbitai", kind: "advisory", refusal: "rate limit" }];
  // io injected so this needs no network: [login, created_at, body] rows.
  const io = (comments, reviews) => ({ comments, reviews });

  // Nobody has said anything at all: genuinely early, not absent.
  const early = readReviewerStates("o/r", 1, "abc1234567", roster,
    io([], []));
  check(early.every(r => r.state === "NOT_RUN"),
    "silence on a PR nobody has reviewed is NOT_RUN — early, not absent",
    JSON.stringify(early.map(r => r.state)));

  // Another reviewer answered; the rostered one is still silent. That is absence.
  const absent = readReviewerStates("o/r", 1, "abc1234567", roster,
    io([["coderabbitai", "t", "Reviewed commit: `abc1234567`"]], []));
  const codex = absent.find(r => r.login === "codex");
  check(codex.state === "NOT_INSTALLED",
    "a rostered reviewer silent while others answered is NOT_INSTALLED",
    JSON.stringify(codex));

  // And the verdict must treat it as unreachable, which is what reaches
  // REVIEWERS_DOWN — the whole point of producing the state.
  check(codex.state !== "NOT_RUN",
    "which is what distinguishes 'absent' from 'not yet run' for REVIEWERS_DOWN");
}

// ── F-3: a refusal is not only the last word ─────────────────────────────────
{
  const roster = [{ login: "codex", kind: "blocking", refusal: "cannot review" }];
  const io = (comments, reviews = []) => ({ comments, reviews });

  // Control: a refusal AS the last comment was always caught. The fixture must
  // show the old code working, or the case below proves nothing.
  const lastWord = readReviewerStates("o/r", 1, "abc1234567", roster,
    io([["codex", "t1", "I cannot review this right now"]]));
  check(lastWord[0].state === "REFUSED",
    "control: a refusal as the last comment is REFUSED", JSON.stringify(lastWord[0]));

  // The defect: any later chatter buried it. Both bots comment constantly.
  const buried = readReviewerStates("o/r", 1, "abc1234567", roster,
    io([["codex", "t1", "I cannot review this right now"],
        ["codex", "t2", "Thanks for the ping!"]]));
  check(buried[0].state === "REFUSED",
    "a refusal followed by unrelated chatter is STILL refused", JSON.stringify(buried[0]));

  // It is superseded only by a SUBSTANTIVE answer: one naming a revision, which
  // is the same evidence coverage requires.
  const recovered = readReviewerStates("o/r", 1, "abc1234567", roster,
    io([["codex", "t1", "I cannot review this right now"],
        ["codex", "t2", "Reviewed commit: `abc1234567` — Codex Review: no major issues"]]));
  check(recovered[0].state === "CLEAN" && recovered[0].reviewedHead === "abc1234567",
    "and a later answer that names a revision DOES supersede it", JSON.stringify(recovered[0]));

  const byReview = readReviewerStates("o/r", 1, "abc1234567", roster,
    io([["codex", "t1", "I cannot review this right now"]],
       [["codex", "abc1234567890abcdef", "COMMENTED", "findings"]]));
  check(byReview[0].state === "VERDICT",
    "a later review object supersedes it too", JSON.stringify(byReview[0]));
}

// ── F-6: staleness has a default ─────────────────────────────────────────────
{
  const bare = { schemaVersion: 1, project: { kind: "product" },
    identity: { key: "o/r", defaultBranch: "main", visibility: "private" },
    authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
    state: { mode: "sibling", location: "o/l" },
    units: [{ id: "root", root: ".", language: "typescript" }],
    ci: { provider: "none" }, merge: { method: "squash", enforcement: "attested" } };

  check(bare.watch === undefined, "control: the profile as written declares no watch block");
  check(withDefaults(bare).watch?.staleSeconds === 900,
    "staleSeconds is defaulted — unset would be an INFINITE staleness bound",
    JSON.stringify(withDefaults(bare).watch));

  // A client-kind profile must get it too: freshness is not a policy dial, and a
  // per-kind default is one forgotten kind away from Infinity.
  const client = withDefaults({ ...bare, project: { kind: "client" } });
  check(client.watch?.staleSeconds === 900, "for every project kind, not just product",
    JSON.stringify(client.watch));

  // An explicit value is never overridden.
  const explicit = withDefaults({ ...bare, watch: { staleSeconds: 60 } });
  check(explicit.watch.staleSeconds === 60, "and an explicit value wins");
}

// ── the new profile keys validate ────────────────────────────────────────────
{
  const p = withDefaults({ schemaVersion: 1, project: { kind: "product" },
    identity: { key: "o/r", defaultBranch: "main", visibility: "private" },
    authority: { permission: "admin", policy: "propose_and_merge", profileLocation: "sidecar" },
    state: { mode: "sibling", location: "o/l" },
    units: [{ id: "root", root: ".", language: "typescript" }],
    ci: { provider: "none", reviewerStatusContexts: ["CodeRabbit"] },
    reviewers: [{ login: "codex", kind: "blocking", refusal: "cannot review",
                  commitPattern: "Reviewed commit:\\s*`?([0-9a-f]{7,40})`?" }],
    merge: { method: "squash", enforcement: "attested" } });
  const r = validate(p);
  check(r.ok, "ci.reviewerStatusContexts and reviewers[].commitPattern validate",
    JSON.stringify(r.errors));

  // A detector that cannot compile is refused, not carried to a runtime throw
  // inside a tick.
  const bad = { ...p, reviewers: [{ login: "x", kind: "blocking", refusal: "r", commitPattern: "([unclosed" }] };
  const rb = validate(bad);
  check(!rb.ok && rb.errors.some(e => /not a valid regex/.test(e)),
    "and an uncompilable pattern is refused at validation", JSON.stringify(rb.errors));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
