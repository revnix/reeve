// A commit's checks as they stood at a time (#342): what a merge was judged
// on, read after it. GitHub's latest attempt of a check may come after the
// time asked about, so every attempt is read and the one that stood is kept.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";
import { tempDir } from "./fixtures/temp.mjs";

const HEAD = "a".repeat(40), MERGE = "d".repeat(40), PARENT = "e".repeat(40);
const T = Date.parse("2026-10-02T12:00:00Z") / 1000;
/** An ISO time `s` seconds from T. */
const at = (/** @type {number} */ s) => new Date((T + s) * 1000).toISOString();
/** The module, or why it can't be had. */
const reconciler = async () => import("../src/github/reconciler.mjs");

/** A check run as GitHub's `check-runs?filter=all` gives one, a line of `.check_runs[]`. */
const runJson = (/** @type {string} */ name, /** @type {string | null} */ conclusion, /** @type {number} */ started, /** @type {number | null} */ completed,
                 { suite = 5, app = 15368, slug = "github-actions", id = 1 } = {}) =>
  JSON.stringify({ name, id, status: completed == null ? "in_progress" : "completed", conclusion: completed == null ? null : conclusion,
                   started_at: at(started), completed_at: completed == null ? null : at(completed), app: { id: app, slug }, check_suite: { id: suite } });
/** A commit status as `statuses` gives one, a line of `.[]`. */
const statusJson = (/** @type {string} */ context, /** @type {string} */ state, /** @type {number} */ created) =>
  JSON.stringify({ context, state, description: "", created_at: at(created), updated_at: at(created) });

/** `fn` with gh answering, by the path asked, the lines given for check runs, statuses and the merge commit. */
const withGh = (/** @type {{ runs?: string[], statuses?: string[], merge?: string, runsFail?: boolean, later?: { runs?: string[], statuses?: string[] } }} */ answers,
                /** @type {() => any} */ fn) => {
  const bin = tempDir("reeve-checks-at-bin-");
  const lines = (/** @type {string[]} */ xs) => xs.map((x) => `'${x}'`).join(" ");
  writeFileSync(join(bin, "gh"), `#!/bin/sh
for a in "$@"; do case "$a" in repos/*) p="$a";; --paginate) all=1;; esac; done
case "$p" in
  */commits/${HEAD}/check-runs*filter=all*) ${answers.runsFail ? 'echo "gh: HTTP 502" >&2; exit 1' : `printf '%s\\n' ${lines(answers.runs ?? [])}`}
    [ -n "$all" ] && printf '%s\\n' ${lines(answers.later?.runs ?? [])};;
  */commits/${HEAD}/statuses*) printf '%s\\n' ${lines(answers.statuses ?? [])}
    [ -n "$all" ] && printf '%s\\n' ${lines(answers.later?.statuses ?? [])};;
  */commits/${MERGE}) printf '%s\\n' '${answers.merge ?? ""}';;
  *) echo "not a read this test answers: $p" >&2; exit 1;;
esac
`, { mode: 0o755 });
  const path = process.env.PATH;
  try { process.env.PATH = `${bin}:${path}`; return fn(); }
  finally { process.env.PATH = path; rmSync(bin, { recursive: true, force: true }); }
};

test("a check's attempt that finished by the time stands, though a later attempt replaced it on GitHub", async () => {
  const r = await reconciler();
  assert.equal(typeof r.readChecksAt, "function", "readChecksAt");
  const got = withGh({ runs: [runJson("Build", "success", -600, -60, { id: 1 }), runJson("Build", "failure", 600, 900, { id: 2 })] },
                     () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => [x.name, x.state, x.conclusion, x.id]), [["Build", "completed", "success", "1"]]);
  assert.equal(got.rows[0].suiteId, "5", "carrying its suite, as readChecks does");
  // Of two begun by then, the one begun last, in whatever order GitHub lists them.
  const both = withGh({ runs: [runJson("Build", "failure", -300, -200, { id: 2 }), runJson("Build", "success", -600, -500, { id: 1 })] },
                      () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(both.rows.map((/** @type {any} */ x) => [x.conclusion, x.id]), [["failure", "2"]]);
});

test("an attempt begun but not finished by the time was running then, and one begun after wasn't there", async () => {
  const r = await reconciler();
  const got = withGh({ runs: [runJson("Build", "success", -60, 300), runJson("Lint", "success", 120, 180)] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => [x.name, x.state, x.conclusion]), [["Build", "running", null]]);
  // Two workflows' jobs of one name are two checks, as GitHub lists them.
  const two = withGh({ runs: [runJson("Decide", "success", -300, -200, { suite: 5 }), runJson("Decide", "success", -300, -250, { suite: 6 })] },
                     () => r.readChecksAt("o/r", HEAD, T));
  assert.equal(two.rows.length, 2);
});

test("a status stands as it was last set by the time", async () => {
  const r = await reconciler();
  const got = withGh({ statuses: [statusJson("deploy", "failure", 60), statusJson("deploy", "success", -60), statusJson("deploy", "pending", -600),
                                  statusJson("docs", "pending", -30)] }, () => r.readChecksAt("o/r", HEAD, T));
  assert.deepEqual(got.rows.map((/** @type {any} */ x) => [x.name, x.state, x.conclusion]).sort(), [["deploy", "completed", "success"], ["docs", "running", null]]);
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
});

test("the commit a merge went onto is its merge commit's first parent", async () => {
  const r = await reconciler();
  assert.equal(typeof r.mergedOnto, "function", "mergedOnto");
  assert.equal(withGh({ merge: PARENT }, () => r.mergedOnto("o/r", MERGE)), PARENT);
  assert.equal(withGh({ merge: "" }, () => r.mergedOnto("o/r", MERGE)), null, "no parent read");
  assert.equal(withGh({ merge: "not a sha" }, () => r.mergedOnto("o/r", MERGE)), null);
});
