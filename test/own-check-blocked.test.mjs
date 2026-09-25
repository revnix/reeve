// A required reeve check must not block on its own absence (#159).
//
// GitHub's mergeStateStatus counts reeve's own check once that check is required.
// The verdict read BLOCKED as a reason to block, published failure, and so kept
// GitHub BLOCKED: every verdict after the first was BLOCK, for ever. These tests
// build verdicts that are satisfied in every other way, with BLOCKED standing
// for each reason GitHub can have, and check which of them still block.
import { computeVerdict, PASS, BLOCK, UNKNOWN } from "../src/verdict.mjs";
import { readMergeParts, readThreads } from "../src/pr.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const HEAD = "bfbbe6ed6a1c2d3e4f5061728394a5b6c7d8e9f0";
// Satisfied in every other way, as test/verdict.test.mjs builds it, and BLOCKED.
const blocked = (parts) => ({
  head: HEAD,
  checks: { verdict: "GREEN", settled: true, failing: [] },
  base: { verdict: "GREEN" },
  reviewers: [{ login: "codex", kind: "blocking", state: "CLEAN", reviewedHead: HEAD.slice(0, 10) }],
  rounds: { n: 2, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 4, readable: true },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "BLOCKED",
  mergeParts: { mergeable: "MERGEABLE", reviewDecision: "APPROVED", ownCheckRequired: true, ...parts },
});
const verdictOf = (parts) => computeVerdict(blocked(parts));
const mergeable = (parts) => verdictOf(parts).clauses.find((c) => c.id === "mergeable");

// ── the verdict ──────────────────────────────────────────────────────────────
{
  const v = verdictOf({});
  check(v.state === PASS && /reeve's own required check/.test(mergeable({}).detail),
    "with reeve's check required and absent, a head that passes everything else reaches PASS", JSON.stringify(v.clauses.filter((c) => c.state !== PASS)));
  check(verdictOf({ reviewDecision: null }).state === PASS, "and so it does where no review is required at all");
}
check(mergeable({ mergeable: "CONFLICTING" }).state === BLOCK, "a conflict with the base still blocks", JSON.stringify(mergeable({ mergeable: "CONFLICTING" })));
check(mergeable({ reviewDecision: "REVIEW_REQUIRED" }).state === BLOCK && mergeable({ reviewDecision: "CHANGES_REQUESTED" }).state === BLOCK,
  "an outstanding or refused review still blocks", JSON.stringify([mergeable({ reviewDecision: "REVIEW_REQUIRED" }), mergeable({ reviewDecision: "CHANGES_REQUESTED" })]));
check(mergeable({ ownCheckRequired: false }).state === BLOCK,
  "control: BLOCKED while reeve's check isn't required is someone else's block, and blocks", JSON.stringify(mergeable({ ownCheckRequired: false })));
check(mergeable({ ownCheckRequired: null }).state === UNKNOWN,
  "BLOCKED when whether reeve's check is required couldn't be read is UNKNOWN, never a pass", JSON.stringify(mergeable({ ownCheckRequired: null })));
check(mergeable({ mergeable: "UNKNOWN" }).state === UNKNOWN,
  "BLOCKED while GitHub hasn't settled whether the branch merges is UNKNOWN", JSON.stringify(mergeable({ mergeable: "UNKNOWN" })));
{
  const i = blocked({}); delete i.mergeParts;
  check(computeVerdict(i).clauses.find((c) => c.id === "mergeable").state === BLOCK,
    "control: without the parts, BLOCKED blocks as before");
}

// ── reading the parts ────────────────────────────────────────────────────────
{
  const calls = [];
  const gh = (args) => {
    const path = args.find((a) => a.startsWith("repos/"));
    calls.push(path);
    if (path.includes("/rules/branches/")) return { ok: true, out: JSON.stringify({ type: "required_status_checks",
      parameters: { required_status_checks: [{ context: "ops/merge-policy", integration_id: 1 }] } }) };
    return { ok: true, out: JSON.stringify({ protected: true, protection: { enabled: false, required_status_checks: { contexts: [], checks: [] } } }) };
  };
  const parts = readMergeParts("o/r", "parts-main", { mergeState: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "APPROVED" }, { gh, appId: "1" });
  check(parts.ownCheckRequired === true && parts.mergeable === "MERGEABLE" && parts.reviewDecision === "APPROVED"
    && calls.some((c) => c.includes("/rules/branches/parts-main")) && calls.some((c) => /\/branches\/parts-main$/.test(c)),
    "when BLOCKED, the parts read whether reeve's check is required on the base, from its rules and its protection", JSON.stringify({ parts, calls }));
  calls.length = 0;
  const clean = readMergeParts("o/r", "parts-clean", { mergeState: "CLEAN", mergeable: "MERGEABLE" }, { gh, appId: "1" });
  check(calls.length === 0 && clean.ownCheckRequired === null, "control: in any other state nothing more is read", JSON.stringify({ clean, calls }));
}
{
  const page = { data: { repository: { pullRequest: { mergeStateStatus: "BLOCKED", mergeable: "MERGEABLE", reviewDecision: "APPROVED",
    reviews: { totalCount: 1 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
  const t = readThreads("o/r", 7, { gh: () => ({ ok: true, out: JSON.stringify(page) }) });
  check(t.mergeState === "BLOCKED" && t.mergeable === "MERGEABLE" && t.reviewDecision === "APPROVED" && t.partsReadable === true,
    "the pull request's own read carries mergeable and the review decision", JSON.stringify(t));
  // An HTTP 200 can carry an error for one field, which then reads as null, and a
  // null review decision would read as "no review outstanding".
  const partial = { ...page, errors: [{ message: "Something went wrong while executing your query.", path: ["repository", "pullRequest", "reviewDecision"] }] };
  partial.data = { repository: { pullRequest: { ...page.data.repository.pullRequest, reviewDecision: null } } };
  const e = readThreads("o/r", 7, { gh: () => ({ ok: true, out: JSON.stringify(partial) }) });
  const parts = readMergeParts("o/r", "parts-partial", e, { gh: () => ({ ok: true, out: "[]" }), appId: "1" });
  check(e.partsReadable === false && parts.readable === false && computeVerdict({ ...blocked({}), mergeParts: parts }).clauses.find((c) => c.id === "mergeable").state === UNKNOWN,
    "a GraphQL error in the pull request's read makes its mergeability parts unknown, never a clear review", JSON.stringify({ partsReadable: e.partsReadable, parts }));
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
