// Merge-ready as the first customer defines it (#167): every required CI job
// succeeded, checked job by job; no review finding outstanding; acceptance
// evidence for each acceptance criterion of the task a pull request delivers;
// and the head unchanged since it was verified. The verdict names whichever is
// unmet.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeVerdict } from "../src/verdict.mjs";
import { evaluatePr, clearRequirements } from "../src/pr.mjs";
import { validate } from "../src/profile/schema.mjs";
import { open } from "../src/db/ops.mjs";
import { tempDir } from "./fixtures/temp.mjs";

/** The module, or why it can't be had. */
const acceptance = async () => { try { return await import("../src/acceptance.mjs"); } catch (err) { return assert.fail(`src/acceptance.mjs: ${err}`); } };
const HEAD = "a".repeat(40);

/** A pull request every condition holds for, and the task it delivers evidenced. */
const ready = () => (/** @type {any} */ ({
  head: HEAD,
  checks: { verdict: "GREEN", settled: true, readable: true, failing: [], inherited: [], impostors: [] },
  base: { verdict: "GREEN", readable: true }, reviewers: [], rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 2, readable: true }, ledgerBlockers: 0, mergeState: "CLEAN", profile: { reviewers: [] },
  cleared: { readable: true, uncleared: 0, reviewers: [] }, bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  acceptance: { readable: true, tasks: [12], criteria: 3, missing: [] },
}));
/** The clauses of `input`'s verdict that aren't PASS, by id. */
const unmet = (/** @type {any} */ input) => computeVerdict(input).clauses.filter((c) => c.state !== "PASS").map((c) => c.id);

test("each of the customer's merge-ready conditions unmet keeps a pull request from passing, and the verdict names it", () => {
  assert.deepEqual(unmet(ready()), [], "control: every condition met");
  assert.equal(computeVerdict(ready()).state, "PASS");
  /** @type {[string, (i: any) => void, string, RegExp][]} */
  const cases = [
    // 1. Every required job, one by one: one that never ran isn't "nothing failed".
    ["a required job that didn't run", (i) => { i.checks = { ...i.checks, verdict: "MISSING_REQUIRED", why: "required check(s) missing: e2e" }; }, "ci", /e2e/],
    // 2. A review finding outstanding: its thread unresolved.
    ["a finding outstanding", (i) => { i.threads = { ...i.threads, unresolved: 1 }; }, "threads", /1 of 2 thread\(s\) unresolved/],
    // 3. A criterion of the task delivered without evidence.
    ["a criterion without evidence", (i) => { i.acceptance = { ...i.acceptance, missing: [2] }; }, "acceptance", /criterion 2 of the 3/],
    // 4. Verified at another head than the one there now.
    ["a head moved since it was verified", (i) => { i.profile = { reviewers: [{ login: "rev", kind: "blocking" }] }; i.reviewers = [{ login: "rev", kind: "blocking", state: "APPROVED", reviewedHead: "b".repeat(40) }]; }, "review", /covered at a different revision/],
  ];
  for (const [what, spoil, id, says] of cases) {
    const input = ready();
    spoil(input);
    const v = computeVerdict(input);
    assert.notEqual(v.state, "PASS", what);
    assert.deepEqual(unmet(input), [id], what);
    assert.match(String(v.clauses.find((c) => c.id === id)?.detail), says, what);
  }
});

test("acceptance evidence: a task delivered with every criterion evidenced passes, one without blocks naming it, none delivered isn't asked for, and one that can't be read is unknown", () => {
  const clause = (/** @type {any} */ a) => computeVerdict({ ...ready(), acceptance: a }).clauses.find((c) => c.id === "acceptance");
  assert.equal(clause({ readable: true, tasks: [12], criteria: 3, missing: [] })?.state, "PASS");
  const short = clause({ readable: true, tasks: [12], criteria: 3, missing: [1, 3] });
  assert.equal(short?.state, "BLOCK");
  assert.match(String(short?.detail), /no acceptance evidence for criteria 1 and 3 of the 3 the task delivered names/);
  const none = clause({ readable: true, tasks: [], criteria: 0, missing: [] });
  assert.equal(none?.state, "PASS");
  assert.match(String(none?.detail), /delivers no task/);
  const unread = clause({ readable: false, why: "the task couldn't be found: HTTP 502" });
  assert.equal(unread?.state, "UNKNOWN");
  assert.equal(unread?.kind, "retry");
  // A task whose criteria can't be read is no evidence of none.
  const blank = clause({ readable: true, tasks: [12], criteria: 0, missing: [] });
  assert.equal(blank?.state, "UNKNOWN");
  assert.match(String(blank?.detail), /names no acceptance criteria/);
  // Where the profile names no tasks, there is no clause at all.
  assert.equal(computeVerdict({ ...ready(), acceptance: null }).clauses.some((c) => c.id === "acceptance"), false);
});

test("a task's criteria are the items of its Acceptance criteria section, and the evidence the numbered entries of the pull request's", async () => {
  const a = await acceptance();
  const task = "### Objective\n\nx\n\n### Acceptance criteria\n\n- WHEN a, THE SYSTEM SHALL b.\n  Verified by: a test.\n  - a detail of it, not a criterion\n- THE SYSTEM SHALL c.\n  Verified by: d.\n\n### Allowed paths\n\n- `src/**`\n";
  assert.equal(a.criteriaOf(task), 2);
  assert.equal(a.criteriaOf("### Objective\n\nno criteria here\n"), 0);
  const pr = "## Why\n\n1. not evidence\n\n## Acceptance evidence\n\n1. `test/x.test.mjs` fails first, then passes\n2.\n3. https://example.com/shot.png\n\n## Tests\n\n4. not evidence either\n";
  assert.deepEqual([...a.evidenceOf(pr)].sort(), [1, 3], "an entry with nothing in it is no evidence");
  assert.deepEqual([...a.evidenceOf("no section")], []);
  assert.deepEqual(a.missingEvidence(3, a.evidenceOf(pr)), [2]);
  // A list indented one to three spaces is top-level all the same; an item indented under one isn't.
  assert.equal(a.criteriaOf("### Acceptance criteria\n\n  - one\n    - a detail of it\n  - two\n"), 2);
  assert.equal(a.criteriaOf("### Acceptance criteria\n\n - one\n - two\n - three\n"), 3);
  assert.equal(a.criteriaOf("### Acceptance criteria\n\n- one\n+ two\n* three\n"), 3, "every marker Markdown takes for a bullet");
  // What a reader doesn't see isn't there: a comment, or a fenced block.
  assert.equal(a.criteriaOf("### Acceptance criteria\n\n<!--\n- an example\n-->\n```\n- in code\n```\n- the one\n"), 1, "hidden criteria");
  assert.equal(a.criteriaOf("### Acceptance criteria\n\n<!-- - an example -->\n~~~md\n- in code\n~~~\n"), 0, "none shown");
  assert.deepEqual([...a.evidenceOf("## Acceptance evidence\n\n<!--\n1. placeholder\n2. placeholder\n-->\n```\n3. in code\n```\n")], [], "hidden evidence");
  assert.deepEqual([...a.evidenceOf("<!--\n## Acceptance evidence\n\n1. placeholder\n-->\n")], [], "a hidden heading");
  assert.equal(a.criteriaOf("### Acceptance criteria\n\n    - in a code block, not a list\n"), 0, "four spaces in is code");
  assert.deepEqual([...a.evidenceOf("## Acceptance evidence\n\n  1. a test\n   2. another\n")].sort(), [1, 2]);
});

/** GitHub as `gh api` answers: a search, an issue's comments and body, by the path asked. */
const github = (/** @type {Record<string, { ok: boolean, out: string, err?: string }>} */ by) => (/** @type {string[]} */ args) => {
  const path = args.find((x) => /^(repos|search)\//.test(x)) ?? "";
  const hit = Object.entries(by).find(([p]) => path.startsWith(p));
  return hit ? hit[1] : { ok: false, out: "", err: `not a read this test answers: ${path}` };
};
const checkpoint = (/** @type {string} */ pr) => `<!-- checkpoint v1 -->\nbranch:     b\nhead:       c\npr:         ${pr}\ndone:       d\n`;
const TASK = "### Acceptance criteria\n\n- one\n- two\n- three\n";

test("the task a pull request delivers is the one whose latest checkpoint names it, found from the private side", async () => {
  const a = await acceptance();
  const ok = (/** @type {string} */ out) => ({ ok: true, out });
  const gh = github({
    "search/issues": ok("12\n13"),
    // Its checkpoint, then a comment that quotes the marker in passing: not a checkpoint.
    "repos/acme/tasks/issues/12/comments": ok([checkpoint("acme/app#7"), "a note quoting one, as an example:\n<!-- checkpoint v1 -->\npr:         acme/app#9\n"].map((c) => JSON.stringify(c)).join("\n")),
    // #13 named it once, and names another pull request now.
    "repos/acme/tasks/issues/13/comments": ok([checkpoint("acme/app#7"), checkpoint("acme/app#9")].map((c) => JSON.stringify(c)).join("\n")),
    "repos/acme/tasks/issues/12": ok(JSON.stringify(TASK)),
  });
  const got = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "## Acceptance evidence\n\n1. a\n2. b\n", tasksRepo: "acme/tasks", gh, cache: new Map() });
  assert.deepEqual(got, { readable: true, tasks: [12], criteria: 3, missing: [3] });
  // Two delivered, one naming no criteria: none can be evidenced for it.
  const blank = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "## Acceptance evidence\n\n1. a\n2. b\n3. c\n", tasksRepo: "acme/tasks", cache: new Map(), gh: github({
    "search/issues": ok("12\n14"),
    "repos/acme/tasks/issues/12/comments": ok(JSON.stringify(checkpoint("acme/app#7"))),
    "repos/acme/tasks/issues/14/comments": ok(JSON.stringify(checkpoint("acme/app#7"))),
    "repos/acme/tasks/issues/12": ok(JSON.stringify(TASK)),
    "repos/acme/tasks/issues/14": ok(JSON.stringify("### Objective\n\nno criteria\n")),
  }) });
  assert.deepEqual(blank, { readable: true, tasks: [12, 14], criteria: 0, missing: [] }, "a task naming no criteria");
  // None names it: no task delivered.
  const none = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "", tasksRepo: "acme/tasks", gh: github({ "search/issues": ok("") }), cache: new Map() });
  assert.deepEqual(none, { readable: true, tasks: [], criteria: 0, missing: [] });
  // A search GitHub says came back incomplete is no search.
  const partial = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "", tasksRepo: "acme/tasks", cache: new Map(), gh: github({ "search/issues": ok("true\n12") }) });
  assert.equal(partial.readable, false, "an incomplete search");
  // A checkpoint after, naming no pull request, doesn't take the task off it.
  const later = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "## Acceptance evidence\n\n1. a\n2. b\n3. c\n", tasksRepo: "acme/tasks", cache: new Map(), gh: github({
    "search/issues": ok("false\n12"),
    "repos/acme/tasks/issues/12/comments": ok([checkpoint("acme/app#7"), "<!-- checkpoint v1 -->\nbranch:     b\ndone:       more\n"].map((c) => JSON.stringify(c)).join("\n")),
    "repos/acme/tasks/issues/12": ok(JSON.stringify(TASK)) }) });
  assert.deepEqual(later, { readable: true, tasks: [12], criteria: 3, missing: [] }, "the latest checkpoint naming a pull request");
  // Issues only: a pull request in the tasks' repository is no task.
  /** @type {string[]} */ let asked = [];
  a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "", tasksRepo: "acme/tasks", cache: new Map(), gh: (/** @type {string[]} */ args) => { asked = args; return ok(""); } });
  assert.match(decodeURIComponent(asked.find((x) => x.startsWith("search/")) ?? ""), /\bis:issue\b/);
  // The search read whole: the task on its second page is found.
  const paged = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "", tasksRepo: "acme/tasks", cache: new Map(), gh: (/** @type {string[]} */ args) => {
    if (args.some((x) => x.startsWith("search/"))) return ok(args.includes("--paginate") ? [...Array.from({ length: 100 }, (_, i) => 200 + i), 12].join("\n") : Array.from({ length: 100 }, (_, i) => 200 + i).join("\n"));
    const path = args.find((x) => x.startsWith("repos/")) ?? "";
    if (/issues\/12\/comments/.test(path)) return ok(JSON.stringify(checkpoint("acme/app#7")));
    if (/issues\/12$/.test(path)) return ok(JSON.stringify(TASK));
    if (/comments/.test(path)) return ok("");
    return { ok: false, out: "", err: "unexpected" };
  } });
  assert.deepEqual(paged.readable && paged.tasks, [12], "every page of the search");
  // The search can't be read: unknown, never "no task".
  const unread = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "", tasksRepo: "acme/tasks", gh: github({ "search/issues": { ok: false, out: "", err: "HTTP 502" } }), cache: new Map() });
  assert.equal(unread.readable, false);
  // Said where a public pull request shows it: never the private repository, nor a task's number.
  assert.doesNotMatch(String(unread.why), /acme\/tasks/);
  const unreadTask = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "", tasksRepo: "acme/tasks", cache: new Map(), gh: github({
    "search/issues": ok("12"), "repos/acme/tasks/issues/12/comments": { ok: false, out: "", err: "HTTP 502 for repos/acme/tasks/issues/12" } }) });
  assert.equal(unreadTask.readable, false);
  assert.doesNotMatch(String(unreadTask.why), /acme\/tasks|#12\b/);
});

test("the task is asked for again on a new head, and otherwise at most hourly", async () => {
  const a = await acceptance();
  let searches = 0;
  const gh = (/** @type {string[]} */ args) => {
    if (args.some((x) => x.startsWith("search/"))) { searches++; return { ok: true, out: "" }; }
    return { ok: false, out: "", err: "unexpected" };
  };
  const cache = new Map();
  const ask = (/** @type {string} */ head, /** @type {number} */ now) => a.acceptanceOf({ nwo: "acme/app", pr: 7, head, body: "", tasksRepo: "acme/tasks", gh, cache, now });
  ask(HEAD, 1000); ask(HEAD, 1000 + 1800);
  assert.equal(searches, 1, "the same head within the hour: asked once");
  ask("b".repeat(40), 1000 + 1801);
  assert.equal(searches, 2, "a new head: asked again");
  ask("b".repeat(40), 1000 + 1801 + 3601);
  assert.equal(searches, 3, "an hour on: asked again");
});

test("a profile may name where its tasks live, as owner/name", () => {
  const base = { schemaVersion: 1, project: { kind: "product" }, identity: { key: "acme/app", defaultBranch: "main", visibility: "public" },
    authority: { permission: "admin", policy: "propose_only", profileLocation: "sidecar" }, state: { mode: "in-repo" },
    units: [{ id: "root", root: ".", language: "javascript", packageManager: "npm", commands: {} }],
    ci: { provider: "github-actions" }, merge: { method: "squash", enforcement: "attested" }, reviewers: [] };
  assert.deepEqual(validate({ ...base, tasks: { repo: "acme/tasks" } }).errors, []);
  assert.match(validate({ ...base, tasks: { repo: "not a repo" } }).errors.join("\n"), /tasks\.repo/);
  // A shorthand that would switch the condition off unseen is refused.
  for (const tasks of ["acme/tasks", ["acme/tasks"], 7]) assert.match(validate({ ...base, tasks }).errors.join("\n"), /tasks must be an object/, JSON.stringify(tasks));
  // A profile committed to a public repository never names where private tasks live.
  const committed = { ...base, authority: { ...base.authority, profileLocation: "committed" }, tasks: { repo: "acme/tasks" } };
  assert.match(validate(committed).errors.join("\n"), /tasks\.repo .*public/);
  assert.deepEqual(validate({ ...committed, identity: { ...base.identity, visibility: "private" } }).errors, [], "a private repository's may");
});

test("evaluatePr asks for acceptance evidence only where the profile names where tasks live", () => {
  const bin = tempDir("reeve-merge-ready-bin-");
  const path = process.env.PATH;
  /** gh as GitHub answers it here: the pull request's body, no task found, and everything else empty. */
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nfor a in "$@"; do case "$a" in repos/*|search/*|graphql) p="$a";; esac; done\ncase "$p" in\n  repos/acme/app/pulls/7) echo '"## Acceptance evidence"';;\n  search/*) ;;\n  graphql) echo '{"data":{"repository":{"pullRequest":{"mergeStateStatus":"CLEAN","mergeable":"MERGEABLE","reviewDecision":null,"reviews":{"totalCount":0},"reviewThreads":{"totalCount":0,"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[]}}}}}';;\n  *) ;;\nesac\n`, { mode: 0o755 });
  writeFileSync(join(bin, "git"), `#!/bin/sh\n[ "$1" = ls-remote ] && printf '%s\\trefs/heads/main\\n' ${"b".repeat(40)}\nexit 0\n`, { mode: 0o755 });
  const anchor = { ok: true, headRef: "f", baseRef: "main", state: "OPEN", title: "t", updatedAt: "2026-10-02T00:00:00Z", head: HEAD, pin: { ok: true, sha: HEAD }, authorLogin: "someone" };
  const db = open(join(tempDir("reeve-merge-ready-db-"), "s.db"));
  try {
    process.env.PATH = `${bin}:${path}`;
    clearRequirements();
    const without = evaluatePr({ nwo: "acme/app", pr: 7, profile: { ci: { requiredChecks: [] }, reviewers: [] }, db, anchor });
    clearRequirements();
    const withTasks = evaluatePr({ nwo: "acme/app", pr: 7, profile: { ci: { requiredChecks: [] }, reviewers: [], tasks: { repo: "acme/tasks" } }, db, anchor });
    assert.equal(without.ok && withTasks.ok, true, `${without.why ?? ""} ${withTasks.why ?? ""}`);
    assert.equal(without.input.acceptance ?? null, null, "no tasks named: not asked");
    assert.deepEqual(withTasks.input.acceptance, { readable: true, tasks: [], criteria: 0, missing: [] }, "named: asked, and none found");
    assert.ok(withTasks.verdict.clauses.some((c) => c.id === "acceptance"));
  } finally { process.env.PATH = path; db.close(); }
});

test("the watcher takes a criterion without evidence to a person, naming it, rather than as a gap", async () => {
  const { nextAction, ACTIONS, ESCALATIONS } = await import("../src/watcher.mjs");
  const input = ready();
  input.acceptance = { ...input.acceptance, missing: [2] };
  const e = { state: "open", pr: 7, head: HEAD, verdict: computeVerdict(input), checks: { verdict: "GREEN", caused: [], inherited: [], failing: [] },
              rounds: input.rounds, reviewers: [], threads: { readable: true, total: 2, unresolved: 0, seen: 2 }, settled: { settled: true } };
  const d = nextAction(e, { authority: { policy: "propose_and_merge" }, watch: {}, reviewers: [] }, { fixAttempts: new Map() });
  assert.equal(d.action, ACTIONS.ESCALATE, JSON.stringify(d));
  assert.equal(d.why, ESCALATIONS.ACCEPTANCE_MISSING);
  assert.match(String(d.detail), /criterion 2 of the 3/);
  assert.notEqual(d.gap, true);
});

test("an answer from GitHub that doesn't read as one is unread, never an empty description or a task with no criteria", async () => {
  const a = await acceptance();
  for (const out of ["", "not json", "{}"]) {
    assert.equal(a.pullBody("acme/app", 7, { gh: () => ({ ok: true, out }) }).ok, false, JSON.stringify(out));
  }
  assert.deepEqual(a.pullBody("acme/app", 7, { gh: () => ({ ok: true, out: JSON.stringify("") }) }), { ok: true, body: "" }, "an empty description, as GitHub says it");
  const ok = (/** @type {string} */ out) => ({ ok: true, out });
  const cache = new Map();
  const garbled = a.acceptanceOf({ nwo: "acme/app", pr: 7, head: HEAD, body: "", tasksRepo: "acme/tasks", cache, gh: github({
    "search/issues": ok("12"), "repos/acme/tasks/issues/12/comments": ok(JSON.stringify(checkpoint("acme/app#7"))), "repos/acme/tasks/issues/12": ok("") }) });
  assert.equal(garbled.readable, false, "a task body that doesn't read");
  assert.equal(cache.size, 0, "and nothing kept for it");
});

test("the alert a criterion without evidence raises names the criteria", async () => {
  const { run, EVAL } = await import("./fixtures/tick-harness.mjs");
  const clauses = EVAL.verdict.clauses.map((/** @type {any} */ c) => ({ ...c, state: "PASS" }));
  const verdict = { state: "BLOCK", summary: "acceptance blocked", clauses: [...clauses, { id: "acceptance", state: "BLOCK", detail: "no acceptance evidence for criterion 2 of the 3 the task delivered names" }] };
  const r = await run({ openPrs: () => [42], evaluate: () => ({ ...EVAL, verdict, checks: { verdict: "GREEN", caused: [], failing: [] } }) });
  assert.match(r.esc, /#42: a criterion of the task it delivers has no acceptance evidence — no acceptance evidence for criterion 2 of the 3/, r.esc);
});
