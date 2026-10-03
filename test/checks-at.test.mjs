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
${Object.entries(answers.ancestors ?? {}).map(([key, xs]) => { const [sha, page = "1"] = key.split("@");
    return `  */commits*sha=${sha}*per_page=100?page=${page}) printf '%s\\n' ${lines(xs)};;`; }).join("\n")}
  */commits*sha=*page=*) ;;
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

test("a commit's checks as each ended: one running at the time, or waiting to start then, counts by how that run finished", async () => {
  const r = await reconciler();
  /** As each ended, and as they stood. @param {Parameters<typeof withGh>[0]} answers */
  const ended = (answers) => withGh(answers, () => r.readChecksAt("o/r", HEAD, T, { ended: true }));
  const stood = (/** @type {Parameters<typeof withGh>[0]} */ answers) => withGh(answers, () => r.readChecksAt("o/r", HEAD, T));
  const shape = (/** @type {any} */ got) => got.rows.map((/** @type {any} */ x) => [x.name, x.state, x.conclusion]);
  // Running at the time, and finished since: as it stood it was running, and it ended as it did.
  const inFlight = { runs: [runJson("Build", "success", -600, 300)] };
  assert.deepEqual(shape(stood(inFlight)), [["Build", "running", null]], "as it stood");
  assert.equal("endedAfter" in stood(inFlight), false, "and nothing said of how any ended");
  let got = ended(inFlight);
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(shape(got), [["Build", "completed", "success"]]);
  assert.deepEqual(got.endedAfter, ["Build"], "named, as taken by a result that came after the time");
  assert.deepEqual(shape(ended({ runs: [runJson("Build", "failure", -600, 300)] })), [["Build", "completed", "failure"]], "one that failed, failed");
  // One finished by the time is as it stood, and isn't named.
  got = ended({ runs: [runJson("Build", "success", -600, -300)] });
  assert.deepEqual([shape(got), got.endedAfter], [[["Build", "completed", "success"]], []]);
  // Still running now: running.
  got = ended({ runs: [runJson("Build", null, -600, null)] });
  assert.deepEqual([got.ok, shape(got), got.endedAfter], [true, [["Build", "running", null]], []]);
  // Waiting to start then, in a suite made before the time, and begun since: as it stood nothing can be told, and it ended as it did.
  const waiting = { runs: [runJson("Gate", "success", 60, 120)] };
  assert.equal(stood(waiting).ok, false, "as it stood");
  got = ended(waiting);
  assert.deepEqual([got.ok, shape(got), got.endedAfter], [true, [["Gate", "completed", "success"]], ["Gate"]]);
  // Not begun even now: running.
  got = ended({ runs: [runJson("Gate", null, null, null)] });
  assert.deepEqual([got.ok, shape(got), got.endedAfter], [true, [["Gate", "running", null]], []]);
  // Run again since: the first to start is the one a gate that waited would have seen finish.
  assert.deepEqual(shape(ended({ runs: [runJson("Gate", "failure", 60, 120, { id: 1 }), runJson("Gate", "success", 600, 700, { id: 2 })] })), [["Gate", "completed", "failure"]]);
  assert.deepEqual(shape(ended({ runs: [runJson("Gate", "success", 600, 700, { id: 2 }), runJson("Gate", "failure", 60, 120, { id: 1 })] })), [["Gate", "completed", "failure"]], "however GitHub lists them");
  // And one in flight at the time, run again since: the one in flight.
  got = ended({ runs: [runJson("Build", "failure", -600, 300, { id: 1 }), runJson("Build", "success", 400, 500, { id: 2 })] });
  assert.deepEqual([got.ok, shape(got)], [true, [["Build", "completed", "failure"]]]);
  // In a suite made after the time it was no part of the commit's checks then, and in one made in that very second that can't be told.
  got = ended({ runs: [runJson("Gate", "success", 60, 120, { suite: 9 })], suites: [suiteJson(9, 30)] });
  assert.deepEqual([got.ok, shape(got)], [true, []]);
  assert.equal(ended({ runs: [runJson("Gate", "success", 60, 120, { suite: 9 })], suites: [suiteJson(9, 0)] }).ok, false, "a suite made in the very second asked");
  // One finished by the time and run again since is still not told: the later run may have been waiting then.
  assert.equal(ended({ runs: [runJson("Build", "success", -600, -300, { id: 1 }), runJson("Build", "failure", 400, 500, { id: 2 })] }).ok, false);
  // A status pending at the time is taken as it was next set to something else, and one set by then is as it stood.
  const pending = statusJson("deploy", "pending", -100, 1);
  assert.deepEqual(shape(stood({ statuses: [pending, statusJson("deploy", "failure", 200, 2)] })), [["deploy", "running", null]], "as it stood: pending");
  got = ended({ statuses: [pending, statusJson("deploy", "pending", 50, 2), statusJson("deploy", "failure", 200, 3), statusJson("deploy", "success", 900, 4)] });
  assert.deepEqual([got.ok, shape(got), got.endedAfter], [true, [["deploy", "completed", "failure"]], ["deploy"]], "the first it was set to since that isn't pending");
  got = ended({ statuses: [pending, statusJson("deploy", "pending", 50, 2)] });
  assert.deepEqual([shape(got), got.endedAfter], [[["deploy", "running", null]], []], "still pending now");
  got = ended({ statuses: [statusJson("deploy", "success", -100, 1), statusJson("deploy", "failure", 200, 2)] });
  assert.deepEqual([shape(got), got.endedAfter], [[["deploy", "completed", "success"]], []], "set by the time: as it stood, whatever it was set to since");
  assert.deepEqual(shape(ended({ statuses: [statusJson("deploy", "success", 200, 1)] })), [], "first set after the time: no part of it");
  // One that reads completed with no time it finished at is taken with its result, and isn't said to have finished after the time: when it did can't be told.
  const undated = JSON.stringify({ ...JSON.parse(runJson("Build", "success", -600, 300)), completed_at: null });
  got = ended({ runs: [undated] });
  assert.deepEqual([got.ok, shape(got), got.endedAfter], [true, [["Build", "completed", "success"]], []], got.why);
  // What's left out of a reading, reeve's own check, isn't named as having ended after the time either.
  got = ended({ runs: [runJson("Build", "success", -600, 300), runJson(r.POLICY_CONTEXT, "neutral", -60, 90, { slug: r.POLICY_APP, suite: 9, id: 3 })],
                suites: [suiteJson(5, -3600, 2), suiteJson(9, -3600, 2)] });
  assert.deepEqual([got.ok, shape(got), got.endedAfter], [true, [["Build", "completed", "success"]], ["Build"]], got.why);
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
  const LAST = "c".repeat(40), EARLIER = "b".repeat(40), OTHER = "f".repeat(40), ENDS = `${MERGE}...${LAST}`;
  /** A record dated `s` seconds from the merge's time: GitHub dates a merge a second or two after the push that carried it. */
  const dated = (/** @type {string} */ type, /** @type {string} */ before, /** @type {string} */ after, /** @type {number | null} */ s = -1) =>
    JSON.stringify({ activity_type: type, before, after, ...(s === null ? {} : { timestamp: at(s) }) });
  /** One of a push of the queue. */
  const queued = (/** @type {string} */ before, /** @type {string} */ after, /** @type {number | null} */ s = -1) => dated("merge_queue_merge", before, after, s);
  const push = queued(PARENT, LAST);
  /** A commit as the read of a commit's ancestors gives one. */
  const commit = (/** @type {string} */ sha, /** @type {string | null} */ parent) => JSON.stringify({ sha, parent });
  /** @param {Parameters<typeof withGh>[0]} answers */
  const onto = (answers) => withGh(answers, () => r.mergedOnto("o/r", "main", MERGE, T, T + 3600));
  // The push carried the merge where its end comes after the merge's commit: GitHub's comparison of the two says "ahead".
  const two = { activity: [push], ancestors: { [MERGE]: [commit(MERGE, PARENT), commit(PARENT, OTHER)] }, compare: { [ENDS]: "ahead" } };
  assert.equal(onto(two), PARENT, "the first of two");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: [commit(MERGE, EARLIER), commit(EARLIER, PARENT), commit(PARENT, OTHER)] } }), PARENT, "the second of three, by its first parents");
  // Unread wherever that isn't shown.
  assert.equal(onto({ ...two, ancestors: {} }), null, "its ancestors unread");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: [commit(MERGE, null)] } }), null, "a commit with no parent");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: [commit(MERGE, EARLIER), commit("9".repeat(40), PARENT)] } }), null,
               "first parents that leave what was listed, beside a commit that isn't one of them");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: ["not json", commit(MERGE, PARENT)] } }), null, "ancestors with a line that doesn't read");
  assert.equal(onto({ ...two, activity: [dated("pr_merge", PARENT, LAST)] }), null, "from that tip a pull request was merged, by no push of the queue");
  assert.equal(onto({ ...two, activity: [dated("push", PARENT, LAST)] }), null, "from that tip a push");
  assert.equal(onto({ ...two, activity: [queued(PARENT, "not-a-sha")], compare: { [`${MERGE}...not-a-sha`]: "ahead" } }), null, "a push that ends at no commit");
  assert.equal(onto({ activity: [queued("main", LAST)], ancestors: { [MERGE]: [commit(MERGE, "main")] }, compare: { [ENDS]: "ahead" } }), null, "a parent that is no commit");
  // The push has to be the one at the merge's own time. A branch set back to a commit of the push and built on again
  // has a later push of the queue from that commit, which carried other merges.
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, 2 * 3600)] }), null, "a push from that tip two hours after the merge");
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, -2 * 3600)] }), null, "one two hours before it");
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, null)] }), null, "one with no time");
  assert.equal(onto({ ...two, activity: [JSON.stringify({ activity_type: "merge_queue_merge", before: PARENT, after: LAST, timestamp: "not a time" })] }), null, "one whose time doesn't read");
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, -60)] }), PARENT, "a minute before the merge is dated: within what's allowed");
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, 0)] }), PARENT, "in the merge's own second");
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, -61)] }), null, "more than a minute before");
  // GitHub dates a merge after the record of the push that carried it, never before: a push recorded after the merge is another.
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, 1)] }), null, "a second after the merge");
  assert.equal(onto({ ...two, activity: [queued(PARENT, LAST, 60)] }), null, "a minute after it");
  // Only such a push counts among the records from a tip (#359): beside one the branch's later history left there,
  // a push after it was set back to that tip say, the merge's own push is still the one.
  const beside = { ...two, compare: { ...two.compare, [`${MERGE}...${OTHER}`]: "ahead" } };
  assert.equal(onto({ ...beside, activity: [queued(PARENT, OTHER, 2 * 3600), push] }), PARENT, "beside a push of the queue from that tip two hours on");
  assert.equal(onto({ ...beside, activity: [dated("push", PARENT, OTHER), push] }), PARENT, "beside a push that isn't the queue's");
  assert.equal(onto({ ...beside, activity: [push, queued(PARENT, OTHER)] }), null, "two of the queue from one tip at the merge's time: which carried it isn't known");
  // And a tip nearer the merge that only another push went on from is passed by: the branch set back to an earlier merge of the push, and built on again.
  assert.equal(onto({ ...beside, activity: [queued(EARLIER, OTHER, 2 * 3600), push], ancestors: { [MERGE]: [commit(MERGE, EARLIER), commit(EARLIER, PARENT), commit(PARENT, OTHER)] } }), PARENT,
               "past an earlier merge of the push that a later push went on from");
  // The push's end has to come after the merge's commit.
  assert.equal(onto({ ...two, compare: {} }), null, "the comparison unread");
  for (const status of ["diverged", "behind", "identical", "not a status"])
    assert.equal(onto({ ...two, compare: { [ENDS]: status } }), null, `a push whose end is ${status} of the merge's commit`);
  // Its first parents are followed past a page of its ancestors (#359): the queue merging by rebase puts a pull request's every commit on the branch.
  /** The `n`th commit of a long line of first parents below the merge. */
  const below = (/** @type {number} */ n) => String(n).padStart(40, "0");
  /** A page of that line: commits `from` to `to`, each with the next as its parent, the last with `then`. */
  const line = (/** @type {number} */ from, /** @type {number} */ to, /** @type {string} */ then) =>
    Array.from({ length: to - from + 1 }, (_, i) => commit(below(from + i), from + i === to ? then : below(from + i + 1)));
  const first = [commit(MERGE, below(1)), ...line(1, 99, below(100))];
  assert.equal(onto({ ...two, ancestors: { [MERGE]: first, [`${MERGE}@2`]: [...line(100, 100, PARENT), commit(PARENT, OTHER)] } }), PARENT, "a tip on the second page of its ancestors");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: first, [`${MERGE}@2`]: line(100, 199, below(200)), [`${MERGE}@3`]: [...line(200, 250, PARENT), commit(PARENT, OTHER)] } }), PARENT, "one on the third");
  assert.equal(onto({ ...two, ancestors: { [MERGE]: first, [`${MERGE}@2`]: line(100, 199, below(200)), [`${MERGE}@3`]: line(200, 299, below(300)), [`${MERGE}@4`]: [...line(300, 300, PARENT), commit(PARENT, OTHER)] } }), null,
               "one on the fourth: not followed that far");
  // A record that ends at the merge's own commit is the merge's, as before, and nothing more is asked.
  const log = join(tempDir("reeve-checks-at-log-"), "asked");
  writeFileSync(log, "");
  assert.equal(withGh({ ...two, activity: [act("merge_queue_merge", PARENT, MERGE)], log }, () => r.mergedOnto("o/r", "main", MERGE, T, T + 3600)), PARENT, "with no time asked of it");
  assert.doesNotMatch(readFileSync(log, "utf8"), /commits|compare/, "its own record found, nothing more asked");
});
