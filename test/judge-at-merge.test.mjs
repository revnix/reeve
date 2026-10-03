// A merged pull request judged once after its merge, as it stood at it (#342):
// its checks and base as GitHub kept them then, what the base's rules made
// GitHub enforce taken as met, and its reviews read after it, those made since
// left out. Decided with the founder on 2026-10-03: edits and resolutions are
// read as they are then, as GitHub keeps no time for them.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { derivePr, reviewState } from "../src/review/derive.mjs";
import { clearRequirements } from "../src/pr.mjs";
import { ingest, noteHead } from "../src/review/ingest.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

/** The module, or why it can't be had. */
const { judgeAtMerge } = await import("../src/at-merge.mjs").catch((err) => ({ judgeAtMerge: () => ({ ok: false, why: `src/at-merge.mjs: ${err}` }) }));

const NWO = "o/r";
const T = 1_800_000_000;
const HEAD = "a".repeat(40);
const PROFILE = {
  watch: { staleSeconds: 900 },
  reviewers: [{ login: "codex", kind: "blocking", refusal: "reached your Codex usage limits", clean: "Didn't find any major issues",
                commitPattern: "Reviewed commit:\\**\\s*`?([0-9a-f]{7,40})`?", severityMarkers: [["!\\[P1 Badge\\]", "critical"]] }],
};
/** A review thread as the store keeps one, begun at `at`. */
const thread = (/** @type {string} */ id, /** @type {number} */ at) => ({
  source: "codex", external_id: `thread:${id}`, kind: "review_thread", head_sha: null, event_at: at, edited_at: null,
  payload: { thread_id: id, author: "codex", body: "**![P1 Badge](x)** a finding", is_resolved: false, is_outdated: false, resolved_by: null, path: "a.ts", line: 1 },
});

test("a pull request's reviews folded up to a time leave out what was made after it", () => {
  const db = open(join(tempDir("reeve-judge-at-merge-db-"), "s.db"));
  try {
    noteHead(db, NWO, 1, HEAD, T);
    ingest(db, NWO, 1, [thread("PRRT_before", T - 60), thread("PRRT_after", T + 60)], { at: T + 120 });
    derivePr(db, NWO, 1, PROFILE, { at: T + 120, head: HEAD });
    assert.equal(reviewState(db, NWO, 1, PROFILE, { at: T + 120 }).total, 2, "control: both, unbounded");
    derivePr(db, NWO, 1, PROFILE, { at: T + 120, head: HEAD, until: T });
    const st = reviewState(db, NWO, 1, PROFILE, { at: T + 120, head: HEAD });
    assert.equal(st.readable, true, st.why);
    assert.equal(st.total, 1, "the thread begun after the time left out");
    // One with no time of its own can't be placed after it, and is kept: leaving out a finding would pass what it might block.
    ingest(db, NWO, 1, [{ ...thread("PRRT_untimed", T), event_at: null }], { at: T + 120 });
    derivePr(db, NWO, 1, PROFILE, { at: T + 120, head: HEAD, until: T });
    assert.equal(reviewState(db, NWO, 1, PROFILE, { at: T + 120, head: HEAD }).total, 2, "kept");
  } finally { db.close(); }
});

const MERGE = "d".repeat(40), ONTO = "e".repeat(40), BASE_NOW = "f".repeat(40);
const at = (/** @type {number} */ s) => new Date((T + s) * 1000).toISOString();
/** A check run as GitHub's check-runs gives one. */
const runJson = (/** @type {string} */ name, /** @type {string} */ conclusion, /** @type {number} */ started, /** @type {number} */ completed,
                 { slug = "github-actions", app = 15368, suite = 5, id = 1 } = {}) =>
  JSON.stringify({ name, id, status: "completed", conclusion, started_at: at(started), completed_at: at(completed), app: { id: app, slug }, check_suite: { id: suite } });
const page = JSON.stringify({ data: { repository: { pullRequest: { mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN", reviewDecision: null,
  reviews: { totalCount: 0 }, reviewThreads: { totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } });
const requires = (/** @type {string[]} */ names) => JSON.stringify({ type: "required_status_checks", parameters: { required_status_checks: names.map((context) => ({ context })) } });

/**
 * `fn` with gh and git answering as GitHub would after a merge at T: the head's
 * checks as every attempt (`then`) and as the latest now (`now`), the commit the
 * merge went onto and its checks then, and the base's tip now, red.
 */
const afterMerge = (/** @type {{ then: string[], now: string[], required?: string[], onto?: boolean, log?: string }} */ o, /** @type {() => any} */ fn) => {
  const bin = tempDir("reeve-judge-at-merge-bin-");
  const lines = (/** @type {string[]} */ xs) => xs.map((x) => `'${x}'`).join(" ");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
for a in "$@"; do case "$a" in repos/*|search/*|graphql) p="$a";; esac; done
${o.log ? `echo "$p" >> '${o.log}'` : ""}
case "$p" in
  graphql) echo '${page}';;
  */actions/jobs/*) echo '{"name":"Build","run_id":1,"attempt":1,"steps":[]}';;
  */commits/${HEAD}/check-runs*filter=all*) printf '%s\\n' ${lines(o.then)};;
  */commits/${HEAD}/check-runs*) printf '%s\\n' ${lines(o.now)};;
  */commits/${ONTO}/check-runs*filter=all*) printf '%s\\n' '${runJson("Build", "success", -900, -800)}';;
  */commits/${BASE_NOW}/check-runs*) printf '%s\\n' '${runJson("Build", "failure", 100, 200)}';;
  */check-suites*) echo 1;;
  */activity*) ${o.onto === false ? "" : `echo '${JSON.stringify({ activity_type: "merge_queue_merge", before: ONTO, after: MERGE })}'`};;
  */rules/branches/*) echo '${requires(o.required ?? ["Build"])}';;
  */branches/main) echo '{"protected":true,"protection":{"enabled":false}}';;
  *) ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = ls-remote ] && printf '%s\\trefs/heads/main\\n' ${BASE_NOW}\nexit 0\n`, { mode: 0o755 });
  const path = process.env.PATH;
  try { process.env.PATH = `${bin}:${path}`; clearRequirements(); return fn(); }
  finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
};
const MERGED = { pr: 7, head: HEAD, mergedAt: T, mergeCommit: MERGE, baseRef: "main", headRef: "feature" };
const profile = { ci: { provider: "github-actions", requiredChecks: [], reviewerStatusContexts: [] }, reviewers: [], watch: { staleSeconds: 900 } };
/** The verdict's clauses of a merge judged after it, by id, the store first prepared by `before`. */
const judged = (/** @type {{ then: string[], now: string[], required?: string[], onto?: boolean, log?: string }} */ o, judgedBy = profile, before = (/** @type {any} */ _db) => {}) => afterMerge(o, () => {
  const db = open(join(tempDir("reeve-judge-at-merge-store-"), "s.db"));
  try {
    before(db);
    const e = judgeAtMerge({ nwo: NWO, merge: MERGED, profile: judgedBy, db, now: T + 600 });
    assert.ok(e.ok, e.why);
    return { ...Object.fromEntries(e.verdict.clauses.map((/** @type {any} */ c) => [c.id, c])), state: e.verdict.state, input: e.input };
  } finally { db.close(); }
});

test("a merge is judged on its head's checks as they stood at it, once, not as they read now", async () => {
  const c = judged({ then: [runJson("Build", "success", -600, -300)], now: [runJson("Build", "failure", 300, 400, { id: 2 })] });
  assert.equal(c.ci.state, "PASS", JSON.stringify(c.ci));
  assert.equal(c.state, "PASS", "a clean merge, judged after it, passes");
  // One that failed then, and today's base failing the same check, isn't taken as the base's failure.
  const failed = judged({ then: [runJson("Build", "failure", -600, -300)], now: [] });
  assert.equal(failed.ci.state, "BLOCK", JSON.stringify(failed.ci));
  assert.doesNotMatch(String(failed.ci.detail), /inherited/);
});

test("a merge's base is judged at the commit it went onto, not the branch's tip now", async () => {
  const c = judged({ then: [runJson("Build", "success", -600, -300)], now: [] });
  assert.equal(c.base.state, "PASS", JSON.stringify(c.base));
  // Where that commit can't be found, the base is unknown, never read at its tip now.
  const log = join(tempDir("reeve-judge-at-merge-log-"), "asked");
  writeFileSync(log, "");
  const unfound = judged({ then: [runJson("Build", "success", -600, -300)], now: [], onto: false, log });
  assert.equal(unfound.base.state, "UNKNOWN", JSON.stringify(unfound.base));
  assert.doesNotMatch(readFileSync(log, "utf8"), /commits\/(null|undefined)\b/, "nothing asked of a commit not found");
});

test("GitHub's merge meets what the base's rules made it enforce", async () => {
  const c = judged({ then: [runJson("Build", "success", -600, -300)], now: [] });
  assert.equal(c.mergeable.state, "PASS", JSON.stringify(c.mergeable));
  assert.match(String(c.mergeable.detail), /merged/i);
  assert.equal(c.input.mergeParts, null, "the base's parts not read now, for a merge GitHub already let through");
  // A live pull request never reads as merged: GitHub's merge states have no such one.
  const { computeVerdict } = await import("../src/verdict.mjs");
  assert.equal(computeVerdict({ mergeState: "MERGED" }).clauses.find((x) => x.id === "mergeable")?.state, "PASS");
});

test("a required check only another App reported, which it may since have rewritten, leaves the merge's checks unknown", async () => {
  const c = judged({ then: [runJson("Build", "success", -600, -300), runJson("Deploy", "success", -600, -300, { slug: "vercel", app: 8329, suite: 7, id: 3 })],
                     now: [], required: ["Build", "Deploy"] });
  assert.equal(c.ci.state, "UNKNOWN", JSON.stringify(c.ci));
  assert.match(String(c.ci.detail), /Deploy/);
});

test("a review thread made after the merge counts nothing against it", async () => {
  const blocking = { ...profile, reviewers: PROFILE.reviewers };
  const checks = { then: [runJson("Build", "success", -600, -300)], now: [] };
  /** The clauses a judgment doesn't pass. @param {any} c */
  const unmet = (c) => Object.values(c).filter((x) => x?.id && x.state !== "PASS").map((x) => `${x.id}:${x.state}`).sort();
  const none = judged(checks, blocking);
  const after = judged(checks, blocking, (db) => ingest(db, NWO, 7, [thread("PRRT_since", T + 60)], { at: T + 120 }));
  assert.deepEqual(unmet(after), unmet(none), "as if there were none");
  // Control: the same thread made before the merge counts.
  const before = judged(checks, blocking, (db) => ingest(db, NWO, 7, [thread("PRRT_then", T - 60)], { at: T - 30 }));
  assert.notDeepEqual(unmet(before), unmet(none));
});
