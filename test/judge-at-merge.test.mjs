// A merged pull request judged once after its merge, as it stood at it (#342):
// its checks and base as GitHub kept them then, what the base's rules made
// GitHub enforce taken as met, and its reviews read after it, those made since
// left out. Decided with the founder on 2026-10-03: edits and resolutions are
// read as they are then, as GitHub keeps no time for them.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { derivePr, deriveSupply, reviewState } from "../src/review/derive.mjs";
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
    // A fold asked no time has nothing to place at one.
    assert.equal(derivePr(db, NWO, 1, PROFILE, { at: T + 120, head: HEAD }).unplaced, null);
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
const requires = (/** @type {string[]} */ names) => JSON.stringify({ type: "required_status_checks", ruleset_source_type: "Repository", ruleset_source: NWO, ruleset_id: 11,
                                                                      parameters: { required_status_checks: names.map((context) => ({ context })) } });
const QUEUE_RULE = JSON.stringify({ type: "merge_queue", ruleset_source_type: "Repository", ruleset_source: NWO, ruleset_id: 11, parameters: {} });
/** The GraphQL page of a pull request with one unresolved thread, begun at `begun`. */
const threadPage = (/** @type {number} */ begun) => JSON.stringify({ data: { repository: { pullRequest: { mergeStateStatus: "UNKNOWN", mergeable: "UNKNOWN", reviewDecision: null,
  reviews: { totalCount: 0 }, reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{
    id: "PRRT_x", isResolved: false, isOutdated: false, isCollapsed: false, resolvedBy: null, path: "a.ts", line: 1, originalLine: 1,
    comments: { nodes: [{ databaseId: 9, author: { login: "someone" }, body: "a question", createdAt: at(begun), updatedAt: at(begun), pullRequestReview: null }] } }] } } } } });

/**
 * `fn` with gh and git answering as GitHub would after a merge at T: the head's
 * checks as every attempt (`then`) and as the latest now (`now`), the commit the
 * merge went onto and its checks then, and the base's tip now, red.
 */
/** @typedef {{ then: string[], now: string[], required?: string[], onto?: boolean, log?: string, comments?: string[], reviews?: string[], page?: string,
 *              rulesetAt?: number | null, orgRuleset?: boolean, classic?: boolean, queue?: string[],
 *              suite?: { result: string, evals?: any[] } | string | null, suites?: number, suiteTwice?: boolean, suiteFails?: boolean, noRules?: boolean, onto_?: string[] }} Shape */
/** A rule's result in GitHub's record of a push, as the reader's query gives one. */
const rule = (/** @type {number} */ id, result = "pass", /** @type {string | null} */ details = null, enforcement = "active") => ({ source: "ruleset", id, result, enforcement, details });
/** GitHub's record of the base's rules passing, the rulesets `ids` judging. */
const passedBy = (/** @type {number[]} */ ids) => ({ result: "pass", evals: ids.map((id) => rule(id)) });
const afterMerge = (/** @type {Shape} */ o, /** @type {() => any} */ fn) => {
  const bin = tempDir("reeve-judge-at-merge-bin-");
  const lines = (/** @type {string[]} */ xs) => xs.map((x) => `'${x}'`).join(" ");
  // The base's pushes as GitHub records its rules judging each: another's first, then the merge's.
  const suites = [JSON.stringify({ id: 20, after_sha: ONTO }),
                  ...Array.from({ length: o.suite === null ? 0 : o.suites ?? 1 }, (_, i) => JSON.stringify({ id: 21 + i, after_sha: MERGE })),
                  // GitHub gives a list's first page twice where it runs past one (measured 2026-10-03): the same record again.
                  ...(o.suiteTwice ? [JSON.stringify({ id: 21, after_sha: MERGE })] : [])];
  const suite = typeof o.suite === "string" ? o.suite : JSON.stringify(o.suite ?? passedBy([11]));
  writeFileSync(join(bin, "gh"), `#!/bin/sh
for a in "$@"; do case "$a" in repos/*|orgs/*|search/*|graphql) p="$a";; esac; done
${o.log ? `echo "$p" >> '${o.log}'` : ""}
case "$p" in
  graphql) echo '${o.page ?? page}';;
  */issues/7/comments*) printf '%s\n' ${lines(o.comments ?? [])};;
  */pulls/7/reviews*) printf '%s\n' ${lines(o.reviews ?? [])};;
  */rulesets/rule-suites/20) echo '${JSON.stringify({ result: "bypass", evals: [rule(11, "fail", "another push")] })}';;
  */rulesets/rule-suites/*) echo '${suite}';;
  */rulesets/rule-suites*) ${o.suiteFails ? "exit 1" : `printf '%s\n' ${lines(suites)}`};;
  orgs/acme/rulesets/11) echo '${JSON.stringify({ id: 11, updated_at: at(o.rulesetAt ?? -86400) })}';;
  */rulesets/11) echo '${o.orgRuleset ? "{}" : JSON.stringify({ id: 11, ...(o.rulesetAt === null ? {} : { updated_at: at(o.rulesetAt ?? -86400) }) })}';;
  */commits/${MERGE}/check-runs*filter=all*) printf '%s\n' ${lines(o.queue ?? [])};;
  */actions/jobs/*) echo '{"name":"Build","run_id":1,"attempt":1,"steps":[]}';;
  */commits/${HEAD}/check-runs*filter=all*) printf '%s\\n' ${lines(o.then)};;
  */commits/${HEAD}/check-runs*) printf '%s\\n' ${lines(o.now)};;
  */commits/${ONTO}/check-runs*filter=all*) printf '%s\\n' ${lines(o.onto_ ?? [runJson("Build", "success", -900, -800)])};;
  */commits/${BASE_NOW}/check-runs*) printf '%s\\n' '${runJson("Build", "failure", 100, 200)}';;
  */check-suites*) printf '%s\n' ${[5, 7, 8].map((id) => `'${JSON.stringify({ id, created_at: at(-3600), total: 4 })}'`).join(" ")} '${JSON.stringify({ id: 9, created_at: at(30), total: 4 })}';;
  */activity*) ${o.onto === false ? "" : `echo '${JSON.stringify({ activity_type: "merge_queue_merge", before: ONTO, after: MERGE })}'`};;
  */rules/branches/*) ${o.noRules ? "exit 0;" : ""} printf '%s\n' '${o.orgRuleset ? requires(o.required ?? ["Build"]).replace('"Repository","ruleset_source":"o/r"', '"Organization","ruleset_source":"acme"') : requires(o.required ?? ["Build"])}' ${o.queue ? `'${QUEUE_RULE}'` : ""};;
  */branches/main) echo '${JSON.stringify({ protected: true, protection: { enabled: o.classic === true } })}';;
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
const judged = (/** @type {Shape} */ o, judgedBy = profile, before = (/** @type {any} */ _db) => {}, hold = /** @type {any} */ (null)) => afterMerge(o, () => {
  const db = open(join(tempDir("reeve-judge-at-merge-store-"), "s.db"));
  try {
    before(db);
    const e = judgeAtMerge({ nwo: NWO, merge: MERGED, profile: judgedBy, db, now: T + 600, hold });
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

test("a merge is judged by GitHub's own record of the base's rules at it: passed, or gone past", async () => {
  const then = [runJson("Build", "success", -600, -300)];
  const c = judged({ then, now: [] });
  assert.equal(c.mergeable.state, "PASS", JSON.stringify(c.mergeable));
  assert.match(String(c.mergeable.detail), /merged/i);
  assert.equal(c.input.mergeParts, null, "the base's parts not read now, for a merge already made");
  // The one record listed twice, as GitHub lists a first page again, is one record.
  assert.equal(judged({ then, now: [], suiteTwice: true }).mergeable.state, "PASS", "listed twice");
  // A bypass went past each rule that failed, which is named; one only evaluated, not enforced, isn't one.
  const past = judged({ then, now: [], suite: { result: "bypass", evals: [rule(11, "fail", "At least 1 approving review is required."), rule(11),
                                                                           rule(11, "fail", "Only evaluated.", "evaluate")] } });
  assert.equal(past.mergeable.state, "BLOCK", JSON.stringify(past.mergeable));
  assert.match(String(past.mergeable.detail), /approving review/);
  assert.doesNotMatch(String(past.mergeable.detail), /Only evaluated/);
  assert.equal(past.state, "BLOCK", "a merge past the rules doesn't pass, whatever else did");
});

test("a merge GitHub keeps no one record of its rules judging is unknown, never taken as passed", async () => {
  const then = [runJson("Build", "success", -600, -300)];
  const mergeable = (/** @type {Partial<Shape>} */ o) => judged({ then, now: [], ...o }).mergeable;
  // None kept, as for a base no ruleset governs; and two for the one commit, which can't be told apart.
  for (const o of [{ suite: null }, { suites: 2 }]) {
    const m = mergeable(o);
    assert.equal(m.state, "UNKNOWN", JSON.stringify(m));
    assert.equal(m.kind, "person", "reading again finds no more");
  }
  // One that couldn't be read is read again.
  for (const o of [{ suiteFails: true }, { suite: "not a record" }]) {
    const m = mergeable(o);
    assert.equal(m.state, "UNKNOWN", JSON.stringify(m));
    assert.equal(m.kind, "retry");
  }
  // A result that's neither isn't a pass.
  assert.equal(mergeable({ suite: { result: "fail", evals: [rule(11, "fail")] } }).state, "UNKNOWN", "a result GitHub gives no merge");
  const { computeVerdict } = await import("../src/verdict.mjs");
  assert.equal(computeVerdict({ mergeState: "MERGED" }).clauses.find((x) => x.id === "mergeable")?.state, "UNKNOWN", "a merge with no reading of its rules");
});

test("a merge judged days after it asks GitHub over a period that reaches it", async () => {
  const log = join(tempDir("reeve-judge-at-merge-log-"), "asked");
  writeFileSync(log, "");
  afterMerge({ then: [], now: [], log }, () => {
    const db = open(join(tempDir("reeve-judge-at-merge-store-"), "s.db"));
    try {
      const e = judgeAtMerge({ nwo: NWO, merge: { ...MERGED, mergedAt: Math.floor(Date.now() / 1000) - 3 * 86400 }, profile, db });
      assert.ok(e.ok, e.why);
    } finally { db.close(); }
  });
  assert.match(readFileSync(log, "utf8"), /\/activity\?[^\n]*time_period=week/, "the commit it went onto, asked of the week");
});

test("a merge's rules are read from GitHub's record over a period that reaches the push, made before the merge", async () => {
  const asked = (/** @type {number} */ ago) => {
    const log = join(tempDir("reeve-judge-at-merge-log-"), "asked");
    writeFileSync(log, "");
    afterMerge({ then: [], now: [], log }, () => {
      const db = open(join(tempDir("reeve-judge-at-merge-store-"), "s.db"));
      try { assert.ok(judgeAtMerge({ nwo: NWO, merge: { ...MERGED, mergedAt: Math.floor(Date.now() / 1000) - ago }, profile, db }).ok); }
      finally { db.close(); }
    });
    return readFileSync(log, "utf8").match(/rule-suites\?[^\n]*time_period=(\w+)/)?.[1] ?? null;
  };
  assert.equal(asked(3600), "day");
  // The queue's commit is recorded when it's made, before it merges: a merge near a day old is asked of the week.
  assert.equal(asked(86400 - 3600), "week");
  assert.equal(asked(3 * 86400), "week");
  assert.equal(asked(20 * 86400), "month");
  // Past what GitHub keeps, nothing is asked, and the merge's rules are unknown.
  assert.equal(asked(40 * 86400), null);
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

/** A clean pass by the blocking reviewer, at `when`, naming the merged head, as the reviewers' read gives a comment. */
const clean = (/** @type {number} */ when) => `codex[bot]\t${at(when)}\tNo major issues found. Reviewed commit: ${HEAD.slice(0, 10)}`;
/** And a review object of its, its time GitHub's submitted_at. */
const reviewed = (/** @type {number} */ when) => `codex[bot]\t${HEAD}\tCOMMENTED\t${at(when)}\tNo major issues found.`;

test("a reviewer's word after the merge counts nothing for it", async () => {
  const blocking = { ...profile, reviewers: PROFILE.reviewers };
  const checks = { then: [runJson("Build", "success", -600, -300)], now: [] };
  const none = judged(checks, blocking);
  assert.notEqual(none.review.state, "PASS", "control: unreviewed");
  assert.deepEqual(judged({ ...checks, comments: [clean(60)] }, blocking).review.state, none.review.state, "a clean pass after it");
  assert.equal(judged({ ...checks, comments: [clean(-60)] }, blocking).review.state, "PASS", "control: one before it");
  // And a review object.
  assert.deepEqual(judged({ ...checks, reviews: [reviewed(60)] }, blocking).review.state, none.review.state, "a review after it");
  assert.equal(judged({ ...checks, reviews: [reviewed(-60)] }, blocking).review.state, "PASS", "control: one before it");
});

test("a reviewer's word in the very second of the merge, which can't be put before it or after, leaves its review unknown", async () => {
  const blocking = { ...profile, reviewers: PROFILE.reviewers };
  const checks = { then: [runJson("Build", "success", -600, -300)], now: [] };
  const tied = judged({ ...checks, comments: [clean(0)] }, blocking).review;
  assert.equal(tied.state, "UNKNOWN", JSON.stringify(tied));
  assert.match(String(tied.detail), /second/);
  // Though an earlier word covered it: one in that second may take it back as well as give it.
  const refusal = `codex[bot]\t${at(0)}\tYou have reached your Codex usage limits`;
  assert.equal(judged({ ...checks, comments: [clean(-60), refusal] }, blocking).review.state, "UNKNOWN", "a refusal in it, after a clean pass");
  assert.equal(judged({ ...checks, reviews: [reviewed(0)] }, blocking).review.state, "UNKNOWN", "a review object in it");
  // Another's word in that second says nothing of this reviewer.
  assert.equal(judged({ ...checks, comments: [clean(-60), `someone\t${at(0)}\tmerging`] }, blocking).review.state, "PASS", "control: another's");
});

test("a thread made after the merge is no thread of it, and the rest of its reviews stay read", async () => {
  const c = judged({ then: [runJson("Build", "success", -600, -300)], now: [], page: threadPage(60) });
  assert.equal(c.threads.state, "PASS", JSON.stringify(c.threads));
  assert.equal(c.state, "PASS", JSON.stringify(Object.values(c).filter((x) => x?.state && x.state !== "PASS")));
  const then = judged({ then: [runJson("Build", "success", -600, -300)], now: [], page: threadPage(-60) });
  assert.equal(then.threads.state, "BLOCK", "control: one made before it, unresolved");
});

test("a merge's checks are unknown where the base's rules changed since it", async () => {
  const then = [runJson("Build", "success", -600, -300)];
  const c = judged({ then, now: [], rulesetAt: 60 });
  assert.equal(c.ci.state, "UNKNOWN", JSON.stringify(c.ci));
  assert.match(String(c.ci.detail), /rules/);
  assert.equal(judged({ then, now: [], rulesetAt: null }).ci.state, "UNKNOWN", "a ruleset whose time doesn't read");
  assert.equal(judged({ then, now: [], classic: true }).ci.state, "UNKNOWN", "classic protection, which keeps no time");
  // An organization's ruleset is read where it lives.
  assert.equal(judged({ then, now: [], orgRuleset: true }).ci.state, "PASS", "an organization's, unchanged");
  assert.equal(judged({ then, now: [], orgRuleset: true, rulesetAt: 60 }).ci.state, "UNKNOWN", "an organization's, changed since");
});

test("a required check another App also reported, which it may have rewritten, is unknown though Actions' run passed", async () => {
  const c = judged({ then: [runJson("Build", "success", -600, -300), runJson("Build", "success", -600, -300, { slug: "vercel", app: 8329, suite: 7, id: 3 })], now: [] });
  assert.equal(c.ci.state, "UNKNOWN", JSON.stringify(c.ci));
});

test("a merge through the queue is judged on the queue's commit for the checks run only there", async () => {
  const queued = { ...profile, ci: { ...profile.ci, queueOnlyChecks: ["Queue review"] } };
  const head = [runJson("Build", "success", -600, -300), runJson("Queue review", "skipped", -600, -300, { id: 2 })];
  const at_ = (/** @type {string[]} */ queue) => judged({ then: head, now: [], required: ["Build", "Queue review"], queue }, queued).ci;
  assert.equal(at_([runJson("Queue review", "success", -200, -100, { suite: 8, id: 4 })]).state, "PASS", "passed there");
  // The base's own runs on that commit after it merged, a push's suite made since, change nothing.
  assert.equal(at_([runJson("Queue review", "success", -200, -100, { suite: 8, id: 4 }), runJson("Build", "success", 60, 120, { suite: 9, id: 5 })]).state, "PASS", "a push since");
  // Nor does another of the queue's jobs, still running when it merged: only the checks run there count.
  assert.equal(at_([runJson("Queue review", "success", -200, -100, { suite: 8, id: 4 }), runJson("Slow job", "success", -200, 300, { suite: 8, id: 6 })]).state, "PASS", "another still running");
  assert.equal(at_([runJson("Queue review", "failure", -200, -100, { suite: 8, id: 4 })]).state, "BLOCK", "failed there");
  assert.notEqual(at_([]).state, "PASS", "never ran there");
  assert.equal(at_([runJson("Queue review", "success", -200, -100, { suite: 8, id: 4 }), runJson("Queue review", "success", -200, -100, { slug: "vercel", app: 8329, suite: 7, id: 7 })]).state,
               "UNKNOWN", "another App's there too");
});

test("a check run only in the queue, skipped there by CI's own decision, is met at the queue's commit as on the live queue", async () => {
  const queued = { ...profile, ci: { ...profile.ci, queueOnlyChecks: ["Queue review"] } };
  const decides = { ...profile, ci: { ...queued.ci, decidedSkips: { by: "Decide", checks: ["Queue review"] } } };
  const head = [runJson("Build", "success", -600, -300), runJson("Queue review", "skipped", -600, -300, { id: 2 })];
  const at_ = (/** @type {string[]} */ queue, judgedBy = decides) => judged({ then: head, now: [], required: ["Build", "Queue review"], queue }, judgedBy).ci;
  /** The queue's commit: the deciding job, and the check it skipped, in one suite. */
  const there = (/** @type {string} */ decider) => [runJson("Decide", decider, -200, -150, { suite: 8, id: 4 }), runJson("Queue review", "skipped", -200, -100, { suite: 8, id: 5 })];
  assert.equal(at_(there("success")).state, "PASS", JSON.stringify(at_(there("success"))));
  // Only by the profile's rule, and only where the deciding job succeeded.
  assert.notEqual(at_(there("success"), queued).state, "PASS", "control: a profile that names no decider");
  assert.notEqual(at_(there("failure")).state, "PASS", "the decider failed");
});

test("a base check another App reported, which it may have rewritten since, leaves the merge's base unknown where its failure would count", async () => {
  const then = [runJson("Build", "success", -600, -300)];
  const build = runJson("Build", "success", -900, -800);
  /** Another App's run at the commit the merge went onto. */
  const theirs = (/** @type {string} */ name) => runJson(name, "success", -900, -800, { slug: "vercel", app: 8329, suite: 7, id: 3 });
  const base = (/** @type {string[]} */ onto_, /** @type {string[]} */ required = ["Build"]) => judged({ then, now: [], onto_, required }).base;
  // Under a required name: it may have failed there then, and read as it does now.
  const doubted = base([build, theirs("Build")]);
  assert.equal(doubted.state, "UNKNOWN", JSON.stringify(doubted));
  // One no rule requires doesn't count on the base, so it leaves it as it is.
  assert.equal(base([build, theirs("Preview")]).state, "PASS", "control: one that wouldn't count");
  // Where the base requires nothing, every check on it counts, another App's too.
  assert.equal(base([build, theirs("Preview")], []).state, "UNKNOWN", "every check counts where none is required");
});

test("a hold the caller read stands in the judgment", async () => {
  const c = judged({ then: [runJson("Build", "success", -600, -300)], now: [] }, profile, () => {}, { readable: false, why: "the hub couldn't be read" });
  assert.equal(c.hold?.state, "UNKNOWN", JSON.stringify(c.hold));
});

test("a merge's checks are unknown where a ruleset that judged it applies no longer", async () => {
  const then = [runJson("Build", "success", -600, -300)];
  // One removed since, which GitHub lists no more: what it required then can't be told.
  const gone = judged({ then, now: [], suite: passedBy([11, 12]) });
  assert.equal(gone.ci.state, "UNKNOWN", JSON.stringify(gone.ci));
  assert.match(String(gone.ci.detail), /rules/);
  // The only one, removed: a base with no rules now isn't one that had none then.
  assert.equal(judged({ then, now: [], noRules: true }).ci.state, "UNKNOWN", "none left");
  // And with no record of what judged it, whether they've changed can't be told.
  assert.equal(judged({ then, now: [], suite: null }).ci.state, "UNKNOWN", "no record of what judged it");
  assert.equal(judged({ then, now: [], suite: passedBy([11]) }).ci.state, "PASS", "control: the one that judged it, still there");
});

test("a merge's acceptance evidence, kept only as it reads now, is unknown, and isn't read", async () => {
  const log = join(tempDir("reeve-judge-at-merge-log-"), "asked");
  writeFileSync(log, "");
  const c = judged({ then: [runJson("Build", "success", -600, -300)], now: [], log }, { ...profile, tasks: { repo: "o/tasks" } });
  assert.equal(c.acceptance?.state, "UNKNOWN", JSON.stringify(c.acceptance));
  assert.match(String(c.acceptance.detail), /as they stood/);
  const asked = readFileSync(log, "utf8").split("\n");
  assert.ok(!asked.includes(`repos/${NWO}/pulls/7`), "its description as it reads now isn't read");
  assert.ok(!asked.some((l) => l.startsWith("search/")), "nor is the task looked for");
});

test("judging a merge leaves the store's fold of its reviews whole, for what reads reviewers across pull requests", async () => {
  const blocking = { ...profile, reviewers: PROFILE.reviewers };
  /** The reviewer's refusal, said after the merge. */
  const refusal = { source: "codex", external_id: "comment:5", kind: "issue_comment", head_sha: null, event_at: T + 60, edited_at: null,
                    payload: { login: "codex[bot]", body: "You have reached your Codex usage limits" } };
  afterMerge({ then: [runJson("Build", "success", -600, -300)], now: [] }, () => {
    const db = open(join(tempDir("reeve-judge-at-merge-store-"), "s.db"));
    try {
      ingest(db, NWO, 7, [refusal], { at: T + 120 });
      const e = judgeAtMerge({ nwo: NWO, merge: MERGED, profile: blocking, db, now: T + 600 });
      assert.ok(e.ok, e.why);
      assert.deepEqual(db.prepare("SELECT outcome FROM review_round WHERE nwo=? AND pr=?").all(NWO, 7).map((/** @type {any} */ r) => r.outcome), ["refusal"],
                       "the refusal since is still folded");
      assert.deepEqual(deriveSupply(db, NWO, blocking, { at: T + 600 }).map((s) => s.state), ["down"], "so the reviewer still reads as down");
    } finally { db.close(); }
  });
});

test("a merge's blocking findings are those that stood at it", async () => {
  const then = [runJson("Build", "success", -600, -300)];
  /** The ledger's clause, a finding of `status` blocking the pull request: the block made at `made`, the finding last changed at `changed`. */
  const findings = (/** @type {string} */ status, /** @type {number} */ made, /** @type {number} */ changed) => judged({ then, now: [] }, profile, (db) => {
    const node = db.prepare("INSERT OR IGNORE INTO node (id, kind, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)");
    node.run("pr:7", "pr", "the pull request", "open", T - 900, T - 900);
    node.run("finding:1", "finding", "a finding", status, T - 900, T + changed);
    db.prepare("INSERT INTO edge (src, dst, type, at) VALUES (?,?,?,?)").run("finding:1", "pr:7", "BLOCKS", T + made);
  }).findings;
  assert.equal(findings("open", -120, -60).state, "BLOCK", "control: one open then, unchanged since");
  assert.equal(findings("done", -120, -60).state, "PASS", "control: one settled before it");
  assert.equal(findings("open", 60, 60).state, "PASS", "one made since blocked nothing of it");
  // One changed since may have stood otherwise then: settled since, it blocked; reopened since, it didn't.
  assert.equal(findings("done", -120, 60).state, "UNKNOWN", "settled since");
  assert.equal(findings("open", -120, 60).state, "UNKNOWN", "changed since, and open now");
  assert.equal(findings("open", -120, 0).state, "UNKNOWN", "changed in the merge's very second");
  // And a block made in that second, of a finding unchanged since long before, can't be put before the merge or after.
  assert.equal(findings("open", 0, -60).state, "UNKNOWN", "made in the merge's very second");
});

test("a review that reads dismissed now, which it may not have been at the merge, leaves its reviews unknown", async () => {
  const blocking = { ...profile, reviewers: PROFILE.reviewers };
  const checks = { then: [runJson("Build", "success", -600, -300)], now: [] };
  /** The blocking reviewer's review, stating a finding in its body, made at `when`. */
  const review = (/** @type {string} */ state, /** @type {number} */ when) => ({
    source: "codex", external_id: "review:5", kind: "review", head_sha: HEAD, event_at: T + when, edited_at: null,
    payload: { login: "codex[bot]", state, commit_id: HEAD, body: "**![P1 Badge](x)** a finding" } });
  const none = judged(checks, blocking);
  const c = judged(checks, blocking, (db) => ingest(db, NWO, 7, [review("DISMISSED", -60)], { at: T - 30 }));
  assert.equal(c.bodyFindings.state, "UNKNOWN", JSON.stringify(c.bodyFindings));
  assert.match(String(c.bodyFindings.detail), /dismissed/);
  assert.equal(c.input.threads.readable, false, "nor are its threads read from a fold that can't be placed");
  // One made since is none of the merge, dismissed or not.
  assert.equal(judged(checks, blocking, (db) => ingest(db, NWO, 7, [review("DISMISSED", 60)], { at: T + 90 })).bodyFindings.state, none.bodyFindings.state, "control: one made since");
});

test("a thread begun in the very second of the merge, which can't be put before it or after, leaves its reviews unknown", async () => {
  const checks = { then: [runJson("Build", "success", -600, -300)], now: [] };
  const c = judged(checks, profile, (db) => ingest(db, NWO, 7, [thread("PRRT_tied", T)], { at: T + 30 }));
  assert.equal(c.threads.state, "UNKNOWN", JSON.stringify(c.threads));
  assert.match(String(c.input.threads.why), /second/);
  // So does a reviewer's round made in it: it may clear a finding, or state one.
  const blocking = { ...profile, reviewers: PROFILE.reviewers };
  /** A comment made in the merge's very second. */
  const said = (/** @type {string} */ source, /** @type {string} */ login, /** @type {string} */ body) =>
    ({ source, external_id: "comment:5", kind: "issue_comment", head_sha: null, event_at: T, edited_at: null, payload: { login, body } });
  const round = judged(checks, blocking, (db) => ingest(db, NWO, 7, [said("codex", "codex[bot]", `Didn't find any major issues. Reviewed commit: ${HEAD.slice(0, 10)}`)], { at: T + 30 }));
  assert.equal(round.input.threads.readable, false, "a reviewer's clean pass in it");
  // Another's comment in that second is read by no clause, and leaves the merge's reviews as they'd be without it.
  const none = judged(checks, blocking);
  const chatter = judged(checks, blocking, (db) => ingest(db, NWO, 7, [said("someone", "someone", "merging this now")], { at: T + 30 }));
  assert.equal(chatter.input.threads.readable, true, String(chatter.input.threads.why));
  for (const id of ["threads", "cleared", "bodyFindings", "bodyReadable"]) assert.equal(chatter[id].state, none[id].state, id);
});
