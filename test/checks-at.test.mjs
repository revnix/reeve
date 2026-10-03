// A commit's checks as they stood at a time (#342): what a merge was judged
// on, read after it. GitHub's latest attempt of a check may come after the
// time asked about, so every attempt is read and the one that stood is kept.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tempDir } from "./fixtures/temp.mjs";

const HEAD = "a".repeat(40), MERGE = "d".repeat(40), PARENT = "e".repeat(40);
const T = Date.parse("2026-10-02T12:00:00Z") / 1000;
/** An ISO time `s` seconds from T. */
const at = (/** @type {number} */ s) => new Date((T + s) * 1000).toISOString();
/** The module, or why it can't be had. */
const reconciler = async () => import("../src/github/reconciler.mjs");

/** A check run as GitHub's `check-runs?filter=all` gives one, a line of `.check_runs[]`. */
const runJson = (/** @type {string} */ name, /** @type {string | null} */ conclusion, /** @type {number | null} */ started, /** @type {number | null} */ completed,
                 { suite = 5, app = 15368, slug = "github-actions", id = 1 } = {}) =>
  JSON.stringify({ name, id, status: completed != null ? "completed" : started != null ? "in_progress" : "queued", conclusion: completed == null ? null : conclusion,
                   started_at: started == null ? null : at(started), completed_at: completed == null ? null : at(completed), app: { id: app, slug }, check_suite: { id: suite } });
/** A commit status as `statuses` gives one, a line of `.[]`. */
const statusJson = (/** @type {string} */ context, /** @type {string} */ state, /** @type {number} */ created, id = 1) =>
  JSON.stringify({ id, context, state, description: "", created_at: at(created), updated_at: at(created) });

/** `fn` with gh answering, by the path asked, the lines given for check runs, statuses and the merge commit. */
/** A check suite as GitHub lists one, made `made` seconds from T. */
/** A suite as the read's query gives one: with how many GitHub counts on the commit, `total`, left out where it's `null`. */
const suiteJson = (/** @type {number} */ id, made = -3600, /** @type {number | null} */ total = 1) => JSON.stringify({ id, created_at: at(made), ...(total === null ? {} : { total }) });
/** The suites `runs` are of, each made an hour before T. @param {string[]} runs */
const suitesOf = (runs) => [...new Set(runs.map((x) => { try { return JSON.parse(x).check_suite.id; } catch { return null; } }).filter((x) => x != null))].map((id, _i, all) => suiteJson(id, -3600, all.length));
const withGh = (/** @type {{ runs?: string[], statuses?: string[], activity?: string[], period?: string, log?: string, suites?: string[], runsFail?: boolean, later?: { runs?: string[], statuses?: string[] },
                              ancestors?: Record<string, string[]>, compare?: Record<string, string> }} */ answers,
                /** @type {() => any} */ fn) => {
  const bin = tempDir("reeve-checks-at-bin-");
  const lines = (/** @type {string[]} */ xs) => xs.map((x) => `'${x}'`).join(" ");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
for a in "$@"; do case "$a" in repos/*) p="$a";; --paginate) all=1;; esac; done
${answers.log ? `echo "$p" >> '${answers.log}'` : ""}
case "$p" in
  */commits/${HEAD}/check-runs*filter=all*) ${answers.runsFail ? 'echo "gh: HTTP 502" >&2; exit 1' : `printf '%s\\n' ${lines(answers.runs ?? [])}`}
    [ -n "$all" ] && printf '%s\\n' ${lines(answers.later?.runs ?? [])};;
  */commits/${HEAD}/statuses*) printf '%s\\n' ${lines(answers.statuses ?? [])}
    [ -n "$all" ] && printf '%s\\n' ${lines(answers.later?.statuses ?? [])};;
  */commits/${HEAD}/check-suites*) printf '%s\\n' ${lines(answers.suites ?? suitesOf([...(answers.runs ?? []), ...(answers.later?.runs ?? [])]))};;
${Object.entries(answers.ancestors ?? {}).map(([sha, xs]) => `  */commits*sha=${sha}*) printf '%s\\n' ${lines(xs)};;`).join("\n")}
${Object.entries(answers.compare ?? {}).map(([ends, x]) => `  */compare/${ends}) printf '%s\\n' '${x}';;`).join("\n")}
  */activity*time_period=${answers.period ?? "day"}*) printf '%s\\n' ${lines(answers.activity ?? [])};;
  *) echo "not a read this test answers: $p" >&2; exit 1;;
esac
`, { mode: 0o755 });
  const path = process.env.PATH;
  try { process.env.PATH = `${bin}:${path}`; return fn(); }
  finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
};

test("a check's attempt that finished by the time stands, and one begun since, or not yet, leaves what stood unknown", async () => {
  const r = await reconciler();
  assert.equal(typeof r.readChecksAt, "function", "readChecksAt");
  const got = withGh({ runs: [runJson("Build", "success", -600, -60, { id: 1 })] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => [x.name, x.state, x.conclusion, x.id]), [["Build", "completed", "success", "1"]]);
  assert.equal(got.rows[0].suiteId, "5", "carrying its suite, as readChecks does");
  // A later attempt begun since, or one still queued, may have been queued then, or the one that stood reset in place: unknown.
  for (const [later, why] of [[runJson("Build", "failure", 600, 900, { id: 2 }), "begun since"], [runJson("Build", null, null, null, { id: 2 }), "still queued"]]) {
    const unsure = withGh({ runs: [runJson("Build", "success", -600, -60, { id: 1 }), later] }, () => r.readChecksAt("o/r", HEAD, T));
    assert.equal(unsure.ok, false, why);
  }
  assert.equal(withGh({ runs: [runJson("Lint", "success", 120, 180)] }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, "a check whose only attempt began since");
  // A run of a suite made after the time wasn't there to be queued then, as a push to the base makes on a commit the queue merged.
  const pushed = withGh({ runs: [runJson("Build", "success", -60, -30), runJson("Lint", "success", 60, 90, { suite: 6, id: 2 })],
                          suites: [suiteJson(5), suiteJson(6, 30)] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(pushed.ok, true, pushed.why);
  assert.deepEqual(pushed.rows.map((/** @type {any} */ x) => x.name), ["Build"], "a suite made since");
  // GitHub's times are whole seconds: one in the very second asked can't be put before it or after.
  for (const [run, why] of [[runJson("Build", "success", -60, 0), "finished in that second"], [runJson("Build", "success", 0, 30), "begun in that second"]])
    assert.equal(withGh({ runs: [run] }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, why);
  assert.equal(withGh({ statuses: [statusJson("deploy", "success", 0)] }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, "a status set in that second");
  // An older attempt reset since doesn't matter: a newer one stood.
  const older = withGh({ runs: [runJson("Build", "failure", 600, 900, { id: 1 }), runJson("Build", "success", -300, -200, { id: 2 })] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(older.ok && older.rows.map((/** @type {any} */ x) => [x.conclusion, x.id]), [["success", "2"]]);
  // Of two begun in one second, the newer by its id, in whatever order GitHub lists them.
  const made = runJson("Build", "success", -300, -200, { id: 1 }), remade = runJson("Build", "failure", -300, -250, { id: 2 });
  for (const runs of [[made, remade], [remade, made]]) {
    const tied = withGh({ runs }, () => r.readChecksAt("o/r", HEAD, T));
    assert.deepEqual(tied.rows.map((/** @type {any} */ x) => [x.conclusion, x.id]), [["failure", "2"]], "a tie");
  }
  // Of two begun by then, the one begun last, in whatever order GitHub lists them.
  const both = withGh({ runs: [runJson("Build", "failure", -300, -200, { id: 2 }), runJson("Build", "success", -600, -500, { id: 1 })] },
                      () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(both.rows.map((/** @type {any} */ x) => [x.conclusion, x.id]), [["failure", "2"]]);
});

test("only GitHub Actions' runs stand as they were, and another App's are named, unvouched", async () => {
  const r = await reconciler();
  // Another App may rewrite a finished run in place, its times kept, and nothing then shows it; Actions makes a new run.
  const got = withGh({ runs: [runJson("Build", "success", -60, -30), runJson("Vercel", "success", -60, -30, { slug: "vercel", app: 8329, suite: 7, id: 2 }),
                              runJson(r.POLICY_CONTEXT, "neutral", -60, -30, { slug: r.POLICY_APP, suite: 9, id: 3 })] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => x.name), ["Build"]);
  assert.deepEqual(got.unvouched, ["Vercel"]);
  assert.deepEqual(got.excluded.map((/** @type {any} */ x) => x.name), [r.POLICY_CONTEXT], "reeve's own still recognised");
});

test("an attempt begun but not finished by the time was running then", async () => {
  const r = await reconciler();
  const got = withGh({ runs: [runJson("Build", "success", -60, 300)] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => [x.name, x.state, x.conclusion]), [["Build", "running", null]]);
  // Two workflows' jobs of one name are two checks, as GitHub lists them.
  const two = withGh({ runs: [runJson("Decide", "success", -300, -200, { suite: 5 }), runJson("Decide", "success", -300, -250, { suite: 6 })] },
                     () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(two.rows.length, 2);
});

test("a status stands as it was last set by the time, its context in any case", async () => {
  const r = await reconciler();
  const got = withGh({ statuses: [statusJson("deploy", "failure", 60), statusJson("deploy", "success", -60), statusJson("deploy", "pending", -600),
                                  statusJson("docs", "pending", -30)] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => [x.name, x.state, x.conclusion]).sort(), [["deploy", "completed", "success"], ["docs", "running", null]]);
  // Of two set in one second, the newer by its id, in whatever order GitHub lists them (newest first, as it does).
  const first = statusJson("deploy", "success", -60, 1), second = statusJson("deploy", "failure", -60, 2);
  for (const statuses of [[second, first], [first, second]])
    assert.deepEqual(withGh({ statuses }, () => r.readChecksAt("o/r", HEAD, T)).rows.map((/** @type {any} */ x) => x.conclusion), ["failure"], "a tie");
  // GitHub takes a status's context whatever its case: CI set again as ci is one status.
  const recased = withGh({ statuses: [statusJson("CI", "failure", -60), statusJson("ci", "success", -30)] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(recased.rows.map((/** @type {any} */ x) => [x.name, x.conclusion]), [["ci", "success"]]);
});

test("a reading at a time is whole or unread, and leaves out what readChecks leaves out", async () => {
  const r = await reconciler();
  const failed = withGh({ runsFail: true, statuses: [] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(failed.ok, false);
  const garbled = withGh({ runs: [runJson("Build", "success", -60, -30), "not json"] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(garbled.ok, false, "a line that doesn't read");
  const got = withGh({ runs: [runJson("Build", "success", -60, -30), runJson(r.POLICY_CONTEXT, "neutral", -60, -30, { slug: r.POLICY_APP })],
                       statuses: [statusJson("CodeRabbit", "success", -30)] },
                     () => r.readChecksAt("o/r", HEAD, T, { reviewerContexts: ["CodeRabbit"] }));
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => x.name), ["Build"], "reeve's own check and a reviewer's status");
  assert.deepEqual(got.reviewerRows.map((/** @type {any} */ x) => x.name), ["CodeRabbit"]);
  // What's left out is no part of what stood: reeve's own check re-run since leaves the rest read.
  const own = withGh({ runs: [runJson("Build", "success", -60, -30), runJson(r.POLICY_CONTEXT, "neutral", -60, -30, { slug: r.POLICY_APP, suite: 9, id: 3 }),
                              runJson(r.POLICY_CONTEXT, "neutral", 60, 90, { slug: r.POLICY_APP, suite: 9, id: 4 })] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(own.ok, true, own.why);
  // Every page of both: what a later page holds stood as much as the first's.
  const paged = withGh({ runs: [runJson("Build", "success", -60, -30)], statuses: [], later: { runs: [runJson("Lint", "failure", -60, -30)], statuses: [statusJson("deploy", "failure", -30)] } },
                       () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(paged.rows.map((/** @type {any} */ x) => x.name).sort(), ["Build", "Lint", "deploy"], "every page");
  // GitHub lists the runs of a commit's latest thousand suites only, and a suite may hold no run: counted as GitHub counts them.
  const thousand = (/** @type {number} */ n, /** @type {number | null} */ counted = n) => Array.from({ length: n }, (_, i) => suiteJson(i + 5, -3600, counted));
  const many = withGh({ runs: [runJson("Build", "success", -60, -30)], suites: thousand(1001) }, () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(many.ok, false, "more than a thousand suites");
  assert.equal(withGh({ runs: [runJson("Build", "success", -60, -30)], suites: thousand(1000) }, () => r.readChecksAt("o/r", HEAD, T)).ok, true, "a thousand, all listed");
  // By GitHub's own count, not by how many it lists: a list cut at a thousand holds a thousand rows of more.
  assert.equal(withGh({ runs: [runJson("Build", "success", -60, -30)], suites: thousand(1000, 1001) }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, "a thousand listed of more counted");
  assert.equal(withGh({ runs: [runJson("Build", "success", -60, -30)], suites: thousand(3, null) }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, "a count that doesn't read");
  assert.equal(withGh({ runs: [runJson("Build", "success", -60, -30)], suites: ["not json"] }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, "suites that don't read");
});

test("a status read now carries no id, as only a check run's leads to its job", async () => {
  const r = await reconciler();
  // The failure-cause reader takes a row with an id for a check run and asks Actions for its job (#342's fifth review).
  const bin = tempDir("reeve-checks-now-bin-");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
for a in "$@"; do case "$a" in repos/*) p="$a";; esac; done
case "$p" in
  */commits/${HEAD}/check-runs*) printf '%s\\n' '${runJson("Build", "failure", -60, -30)}';;
  */commits/${HEAD}/status*) printf '%s\\n' '${statusJson("deploy", "failure", -30, 77)}';;
esac
`, { mode: 0o755 });
  const path = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${path}`;
    const now = r.readChecks("o/r", HEAD);
    assert.equal(now.ok, true, now.why);
    assert.deepEqual(now.rows.map((/** @type {any} */ x) => [x.name, x.source, x.id ?? null]), [["Build", "check_run", "1"], ["deploy", "status", null]]);
  } finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
});

test("the commit a merge went onto is the base branch's before the merge, as GitHub's activity records it", async () => {
  const r = await reconciler();
  assert.equal(typeof r.mergedOnto, "function", "mergedOnto");
  const act = (/** @type {string} */ type, /** @type {string} */ before, /** @type {string} */ after) => JSON.stringify({ activity_type: type, before, after });
  const NOW = T + 3600;
  const onto = (/** @type {string[]} */ activity) => withGh({ activity }, () => r.mergedOnto("o/r", "main", MERGE, T, NOW));
  // A squash, a merge commit, a rebase or the queue's merge: whatever its shape, the branch's tip before it.
  assert.equal(onto([act("push", "f".repeat(40), MERGE), act("merge_queue_merge", PARENT, MERGE)]), PARENT, "the queue's merge");
  assert.equal(onto([act("pr_merge", PARENT, MERGE)]), PARENT, "a pull request merged");
  assert.equal(onto([act("push", PARENT, MERGE)]), null, "a push, no merge");
  assert.equal(onto([act("pr_merge", PARENT, "f".repeat(40))]), null, "another merge");
  assert.equal(onto([act("pr_merge", PARENT, MERGE), act("merge_queue_merge", "f".repeat(40), MERGE)]), null, "two that say otherwise");
  assert.equal(onto([act("pr_merge", "not a sha", MERGE)]), null);
  assert.equal(onto([act("pr_merge", PARENT, MERGE), "not json"]), null, "a line that doesn't read");
  // Asked over a period that covers the merge, however long ago it was.
  const DAY = 86400;
  for (const [ago, period] of [[2 * DAY, "week"], [40 * DAY, "quarter"], [200 * DAY, "year"]])
    assert.equal(withGh({ activity: [act("pr_merge", PARENT, MERGE)], period }, () => r.mergedOnto("o/r", "main", MERGE, T, T + ago)), PARENT, `${ago / DAY} days on`);
  // Past a year, which GitHub's activity doesn't reach: not asked at all.
  const log = join(tempDir("reeve-checks-at-log-"), "asked");
  writeFileSync(log, "");
  assert.equal(withGh({ activity: [act("pr_merge", PARENT, MERGE)], period: "year", log }, () => r.mergedOnto("o/r", "main", MERGE, T, T + 400 * DAY)), null);
  assert.equal(readFileSync(log, "utf8"), "", "past a year, nothing asked");
});

test("an earlier merge of a push of the merge queue went onto the tip before that push", async () => {
  const r = await reconciler();
  const act = (/** @type {string} */ type, /** @type {string} */ before, /** @type {string} */ after) => JSON.stringify({ activity_type: type, before, after });
  // The queue put several merges on the branch in one push. GitHub's activity records it once, from the tip before to the last merge's commit.
  const LAST = "c".repeat(40), EARLIER = "b".repeat(40), ENDS = `${PARENT}...${LAST}`;
  const push = act("merge_queue_merge", PARENT, LAST);
  /** A commit as the read of a commit's ancestors gives one. */
  const commit = (/** @type {string} */ sha, /** @type {string | null} */ parent) => JSON.stringify({ sha, parent });
  /** GitHub's comparison of a push's two ends, as the read gives it. */
  const compared = (/** @type {string[]} */ commits, status = "ahead") => JSON.stringify({ status, commits });
  /** @param {Parameters<typeof withGh>[0]} answers */
  const onto = (answers) => withGh(answers, () => r.mergedOnto("o/r", "main", MERGE, T, T + 3600));
  const two = { activity: [push], ancestors: { [MERGE]: [commit(MERGE, PARENT), commit(PARENT, "f".repeat(40))] }, compare: { [ENDS]: compared([MERGE, LAST]) } };
  assert.equal(onto(two), PARENT, "the first of two");
  assert.equal(onto({ activity: [push], ancestors: { [MERGE]: [commit(MERGE, EARLIER), commit(EARLIER, PARENT), commit(PARENT, "f".repeat(40))] },
                      compare: { [ENDS]: compared([EARLIER, MERGE, LAST]) } }), PARENT, "the second of three, by its first parents");
  // Unread wherever that isn't shown.
  assert.equal(onto({ ...two, ancestors: {} }), null, "its ancestors unread");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: [commit(MERGE, null)] } }), null, "a commit with no parent");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: [commit(MERGE, EARLIER), commit("9".repeat(40), PARENT)] } }), null,
               "first parents that leave what was listed, beside a commit that isn't one of them");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: ["not json", commit(MERGE, PARENT)] } }), null, "ancestors with a line that doesn't read");
  assert.equal(onto({ ...two, activity: [act("pr_merge", PARENT, LAST)] }), null, "from that tip a pull request was merged, by no push of the queue");
  assert.equal(onto({ ...two, activity: [act("push", PARENT, LAST)] }), null, "from that tip a push");
  assert.equal(onto({ ...two, activity: [push, act("merge_queue_merge", PARENT, "f".repeat(40))], compare: { ...two.compare, [`${PARENT}...${"f".repeat(40)}`]: compared([MERGE]) } }), null,
               "two records from one tip");
  assert.equal(onto({ ...two, activity: [act("merge_queue_merge", PARENT, "not-a-sha")], compare: { [`${PARENT}...not-a-sha`]: compared([MERGE]) } }), null, "a push that ends at no commit");
  assert.equal(onto({ activity: [act("merge_queue_merge", "main", LAST)], ancestors: { [MERGE]: [commit(MERGE, "main")] }, compare: { [`main...${LAST}`]: compared([MERGE, LAST]) } }), null,
               "a parent that is no commit");
  assert.equal(onto({ ...two, compare: {} }), null, "the comparison unread");
  assert.equal(onto({ ...two, compare: { [ENDS]: "not json" } }), null, "a comparison that doesn't read");
  assert.equal(onto({ ...two, compare: { [ENDS]: compared([EARLIER, LAST]) } }), null, "a push that didn't carry it");
  assert.equal(onto({ ...two, compare: { [ENDS]: compared([MERGE, LAST], "diverged") } }), null, "ends that diverged");
  // A record that ends at the merge's own commit is the merge's, as before, and nothing more is asked.
  const log = join(tempDir("reeve-checks-at-log-"), "asked");
  writeFileSync(log, "");
  assert.equal(withGh({ ...two, activity: [act("merge_queue_merge", PARENT, MERGE)], log }, () => r.mergedOnto("o/r", "main", MERGE, T, T + 3600)), PARENT);
  assert.doesNotMatch(readFileSync(log, "utf8"), /commits|compare/, "its own record found, nothing more asked");
});
