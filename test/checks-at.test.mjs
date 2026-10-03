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
const statusJson = (/** @type {string} */ context, /** @type {string} */ state, /** @type {number} */ created) =>
  JSON.stringify({ context, state, description: "", created_at: at(created), updated_at: at(created) });

/** `fn` with gh answering, by the path asked, the lines given for check runs, statuses and the merge commit. */
const withGh = (/** @type {{ runs?: string[], statuses?: string[], activity?: string[], period?: string, log?: string, runsFail?: boolean, later?: { runs?: string[], statuses?: string[] } }} */ answers,
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
  // GitHub's times are whole seconds: one in the very second asked can't be put before it or after.
  for (const [run, why] of [[runJson("Build", "success", -60, 0), "finished in that second"], [runJson("Build", "success", 0, 30), "begun in that second"]])
    assert.equal(withGh({ runs: [run] }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, why);
  assert.equal(withGh({ statuses: [statusJson("deploy", "success", 0)] }, () => r.readChecksAt("o/r", HEAD, T)).ok, false, "a status set in that second");
  // An older attempt reset since doesn't matter: a newer one stood.
  const older = withGh({ runs: [runJson("Build", "failure", 600, 900, { id: 1 }), runJson("Build", "success", -300, -200, { id: 2 })] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(older.ok && older.rows.map((/** @type {any} */ x) => [x.conclusion, x.id]), [["success", "2"]]);
  // Of two begun by then, the one begun last, in whatever order GitHub lists them.
  const both = withGh({ runs: [runJson("Build", "failure", -300, -200, { id: 2 }), runJson("Build", "success", -600, -500, { id: 1 })] },
                      () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(both.rows.map((/** @type {any} */ x) => [x.conclusion, x.id]), [["failure", "2"]]);
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
  // Every page of both: what a later page holds stood as much as the first's.
  const paged = withGh({ runs: [runJson("Build", "success", -60, -30)], statuses: [], later: { runs: [runJson("Lint", "failure", -60, -30)], statuses: [statusJson("deploy", "failure", -30)] } },
                       () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(paged.rows.map((/** @type {any} */ x) => x.name).sort(), ["Build", "Lint", "deploy"], "every page");
  // GitHub lists the runs of a commit's latest thousand suites only: as many may not be all.
  const many = withGh({ runs: Array.from({ length: 1000 }, (_, i) => runJson(`Job ${i}`, "success", -60, -30, { suite: i + 1, id: i + 1 })) },
                      () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(many.ok, false, "a thousand suites");
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
