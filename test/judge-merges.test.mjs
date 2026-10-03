// Each merge judged as a tick ends (#342): what merged since the last look is
// judged once, as it stood at its merge, and kept as its own event, so a merge
// between two ticks, or while the daemon was down, isn't missed.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { open } from "../src/db/ops.mjs";
import { mergedSince } from "../src/trial.mjs";
import { run } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

/** The module, or why it can't be had. */
const M = await import("../src/merges.mjs").catch((err) => ({ judgeMerges: () => assert.fail(`src/merges.mjs: ${err}`), MERGE_JUDGED: "", MERGES_LOOKED: "",
                                                               FIRST_LOOK_SECONDS: NaN, JUDGED_A_TICK: NaN, AGAIN_FOR_SECONDS: NaN }));
const { judgeMerges, MERGE_JUDGED, MERGES_LOOKED, FIRST_LOOK_SECONDS, JUDGED_A_TICK, AGAIN_FOR_SECONDS } = M;
/** The event a merge's first judgment that didn't settle is kept as, or a name no event has while the source has none. */
const MERGE_TRIED = /** @type {any} */ (M).MERGE_TRIED ?? "no such event yet";

const NWO = "o/r";
const T = 1_800_000_000;
const sha = (/** @type {string} */ c) => c.repeat(40);
/** A merge as GitHub lists one, `ago` seconds before T. */
const merge = (/** @type {number} */ pr, /** @type {number} */ ago, over = {}) =>
  ({ pr, mergedAt: T - ago, head: sha("a"), mergeCommit: sha("d"), baseRef: "main", headRef: "feature", author: "someone", title: `pull request ${pr}`, ...over });
/** A judgment's verdict, as judgeAtMerge gives one. */
const verdict = (/** @type {string} */ state, /** @type {string | null} */ kind = null) =>
  ({ ok: true, verdict: { state, ...(kind ? { kind } : {}), summary: state === "PASS" ? "every clause satisfied at this revision" : "mergeable could not be determined",
                          clauses: [{ id: "mergeable", state, detail: "as it stood" }] } });
/** A store, the events of `op` in it, and a look at `now` whose reads and judgments are recorded. */
const world = () => {
  const db = open(join(tempDir("reeve-judge-merges-"), "s.db"));
  /** @type {any[]} */ const asked = [];
  /** @type {any[]} */ const judgedWith = [];
  /** @type {string[]} */ const said = [];
  const events = (/** @type {string} */ op) => /** @type {any[]} */ (db.prepare("SELECT at, subject, payload FROM event WHERE op = ? ORDER BY seq").all(op))
    .map((r) => ({ at: r.at, subject: r.subject, ...JSON.parse(r.payload) }));
  /** @param {number} now @param {any} list @param {(m: any) => any} [judge] @param {any} [more] */
  const look = (now, list, judge = () => verdict("PASS"), more = {}) => judgeMerges({
    nwo: NWO, profile: {}, db, now, ran: { code: { commit: "c0de" }, policy: "p0licy" },
    merged: (/** @type {string} */ nwo, /** @type {number} */ since, /** @type {any} */ o) => { asked.push({ nwo, since, ...o }); return typeof list === "function" ? list(since) : list; },
    judge: (/** @type {any} */ a) => { judgedWith.push(a); return judge(a.merge); },
    log: (line) => said.push(line), ...more });
  return { db, asked, judgedWith, said, events, look };
};

test("each merge since the last look is judged once, as it stood, and kept as its own event", () => {
  const w = world();
  try {
    const got = w.look(T, [merge(7, 600), merge(8, 300, { head: sha("b"), mergeCommit: sha("e") })]);
    assert.deepEqual(got, { ok: true, judged: 2, waiting: 0 });
    // The first look reaches back a day, and asks for what judging a merge needs.
    assert.deepEqual(w.asked[0], { nwo: NWO, since: T - FIRST_LOOK_SECONDS, until: T, whole: true });
    assert.deepEqual(w.judgedWith.map((a) => a.merge), [
      { pr: 7, head: sha("a"), mergedAt: T - 600, mergeCommit: sha("d"), baseRef: "main", headRef: "feature", title: "pull request 7" },
      { pr: 8, head: sha("b"), mergedAt: T - 300, mergeCommit: sha("e"), baseRef: "main", headRef: "feature", title: "pull request 8" }]);
    assert.equal(w.judgedWith[0].now, T);
    const kept = w.events(MERGE_JUDGED);
    assert.deepEqual(kept.map((e) => e.subject), ["pr:7", "pr:8"]);
    assert.deepEqual(kept[0], { at: T, subject: "pr:7", head: sha("a"), mergedAt: T - 600, mergeCommit: sha("d"), baseRef: "main", state: "PASS",
                                summary: "every clause satisfied at this revision", clauses: [{ id: "mergeable", state: "PASS", detail: "as it stood" }],
                                code: { commit: "c0de" }, policy: "p0licy" });
    // Never as a pull request's decision: nothing that reads its latest decision reads a merge's.
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM event WHERE op IN ('pr.decided', 'queue.decided')").get().n, 0);
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T], "every merge up to now is judged");
    // The next look starts where this one reached, and judges none again, though GitHub lists it again.
    assert.deepEqual(w.look(T + 300, [merge(8, 300, { head: sha("b"), mergeCommit: sha("e") })]), { ok: true, judged: 0, waiting: 0 });
    assert.equal(w.asked[1].since, T);
    assert.equal(w.judgedWith.length, 2, "none judged twice");
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T, T + 300]);
    // One merged again at another head, reopened it can't be, but the same number re-listed with another head is another merge.
    assert.equal(/** @type {any} */ (w.look(T + 600, [merge(8, -500, { head: sha("c") })])).judged, 1);
  } finally { w.db.close(); }
});

test("one tick judges only so many, the oldest first, and the look reaches no further than the earliest left", () => {
  const w = world();
  try {
    const five = [5, 4, 3, 2, 1].map((n) => merge(n, n * 100));
    const got = w.look(T, five);
    assert.deepEqual(got, { ok: true, judged: JUDGED_A_TICK, waiting: 5 - JUDGED_A_TICK });
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:5", "pr:4", "pr:3"]);
    // The earliest left merged at T - 200: every merge before that second is judged.
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - 201]);
    assert.match(w.said.join("\n"), /3 judged[^\n]*2 left for the next tick/);
    // The next tick asks from there, and judges the rest.
    assert.deepEqual(w.look(T + 300, five), { ok: true, judged: 2, waiting: 0 });
    assert.equal(w.asked[1].since, T - 201);
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:5", "pr:4", "pr:3", "pr:2", "pr:1"]);
    assert.equal(w.events(MERGES_LOOKED).at(-1).upTo, T + 300);
  } finally { w.db.close(); }
});

test("a judgment only reading again settles is made again next tick, and kept as it is an hour after it was first tried", () => {
  for (const [what, judge] of /** @type {[string, (m: any) => any][]} */ ([
    ["a read to make again", () => verdict("UNKNOWN", "retry")],
    ["something still settling", () => verdict("UNKNOWN", "waiting")],
    ["a judgment that couldn't be made", () => ({ ok: false, why: "its head couldn't be pinned" })],
    ["a judgment that threw", () => { throw new Error("the store is locked"); }],
  ])) {
    const w = world();
    try {
      const young = [merge(7, 600), merge(8, 300)];
      assert.deepEqual(w.look(T, young, (m) => (m.pr === 7 ? judge(m) : verdict("PASS"))), { ok: true, judged: 1, waiting: 1 }, what);
      assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:8"], `${what}: not kept, and the one after it is`);
      assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - 601], `${what}: the look stops before it`);
      assert.match(w.said.join("\n"), /merged #7: not judged yet, and read again next tick/);
      // Settled on reading again: kept.
      assert.equal(/** @type {any} */ (w.look(T + 300, young, () => verdict("BLOCK"))).judged, 1, what);
      assert.deepEqual(w.events(MERGE_JUDGED).map((e) => [e.subject, e.state]), [["pr:8", "PASS"], ["pr:7", "BLOCK"]]);
    } finally { w.db.close(); }
    // Never settled: kept as unknown an hour after it was first tried, so the look moves on.
    const stuck = world();
    try {
      assert.equal(/** @type {any} */ (stuck.look(T, [merge(7, 600)], judge)).judged, 0, what);
      assert.equal(/** @type {any} */ (stuck.look(T + AGAIN_FOR_SECONDS - 1, [merge(7, 600)], judge)).judged, 0, `${what}: just under the hour`);
      assert.deepEqual(stuck.events(MERGE_TRIED).map((e) => [e.at, e.subject, e.head, e.mergedAt]), [[T, "pr:7", sha("a"), T - 600]], `${what}: when it was first tried, kept once`);
      assert.deepEqual(stuck.look(T + AGAIN_FOR_SECONDS, [merge(7, 600)], judge), { ok: true, judged: 1, waiting: 0 }, what);
      assert.equal(stuck.events(MERGE_JUDGED)[0].state, "UNKNOWN", what);
      assert.equal(stuck.events(MERGES_LOOKED).at(-1).upTo, T + AGAIN_FOR_SECONDS);
    } finally { stuck.db.close(); }
  }
});

test("a merge found long after it, the daemon down since, is given the same hour: one read that fails isn't its verdict", () => {
  const w = world();
  try {
    const old = [merge(7, 5 * 3600)];
    assert.deepEqual(w.look(T, old, () => verdict("UNKNOWN", "retry")), { ok: true, judged: 0, waiting: 1 }, "not kept, though it merged hours ago");
    assert.deepEqual(w.look(T + 300, old, () => verdict("PASS")), { ok: true, judged: 1, waiting: 0 });
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.state), ["PASS"]);
    // The hour is each merge's own: another of the pull request, tried earlier, doesn't spend it.
    const again = [merge(7, -600, { head: sha("b") })];
    w.look(T + 2 * AGAIN_FOR_SECONDS, again, () => verdict("UNKNOWN", "retry"));
    assert.equal(w.events(MERGE_JUDGED).length, 1, "its first try, not its hour's end");
  } finally { w.db.close(); }
});

test("a look never reaches back before where it started, though the earliest merge left merged in that very second", () => {
  const w = world();
  try {
    w.look(T, []);
    // Merged in the second of the last look, and listed only after it.
    w.look(T + 300, [merge(7, 0)], () => verdict("UNKNOWN", "retry"));
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T, T], "not a second further back each tick");
    w.look(T + 600, [merge(7, 0)], () => verdict("PASS"));
    assert.equal(w.asked.at(-1).since, T, "and it's asked from there, the merge's own second within it");
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:7"]);
  } finally { w.db.close(); }
});

test("an unknown only a person settles is kept at once: reading again changes nothing", () => {
  const w = world();
  try {
    assert.deepEqual(w.look(T, [merge(7, 600)], () => verdict("UNKNOWN", "person")), { ok: true, judged: 1, waiting: 0 });
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => [e.state, e.kind]), [["UNKNOWN", "person"]]);
  } finally { w.db.close(); }
});

test("a merge that couldn't be judged is kept with why, and one GitHub names no merge commit for isn't judged at all", () => {
  const w = world();
  try {
    const list = [merge(7, 600), merge(8, 300, { mergeCommit: null })];
    w.look(T, list, () => ({ ok: false, why: "its head couldn't be pinned" }));
    w.look(T + AGAIN_FOR_SECONDS, list, () => ({ ok: false, why: "its head couldn't be pinned" }));
    assert.deepEqual(w.judgedWith.map((a) => a.merge.pr), [7, 7], "nothing asked of a merge with no commit");
    const kept = w.events(MERGE_JUDGED);
    assert.deepEqual(kept.map((e) => [e.subject, e.state]), [["pr:7", "UNKNOWN"], ["pr:8", "UNKNOWN"]]);
    assert.match(kept[0].summary, /couldn't be judged: its head couldn't be pinned/);
    assert.match(kept[1].summary, /no commit it merged as/);
    assert.deepEqual(kept[0].clauses, []);
  } finally { w.db.close(); }
});

test("a look that can't read what merged judges nothing and keeps no look, so the next starts where the last reached", () => {
  const w = world();
  try {
    w.look(T, []);
    assert.deepEqual(w.look(T + 300, { why: "HTTP 502" }), { ok: false, why: "HTTP 502" });
    assert.equal(w.judgedWith.length, 0);
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T], "no look kept for it");
    assert.match(w.said.join("\n"), /couldn't be read[^\n]*HTTP 502/);
    w.look(T + 600, []);
    assert.equal(w.asked.at(-1).since, T, "from the last look that read");
    // A look that doesn't read, a store's damaged row say, is no look: the first look's reach again.
    w.db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(T + 700, "daemon", MERGES_LOOKED, null, "{not json");
    w.look(T + 900, []);
    assert.equal(w.asked.at(-1).since, T + 900 - FIRST_LOOK_SECONDS);
  } finally { w.db.close(); }
});

test("a builder's merged pull request is judged with its hold unreadable, and another's with none", () => {
  const w = world();
  try {
    w.look(T, [merge(7, 600), merge(8, 500, { headRef: "mp/task-12" }), merge(9, 400, { author: "merge-policy[bot]" })]);
    assert.equal(w.judgedWith[0].hold, null, "none asked for one no builder made");
    for (const a of w.judgedWith.slice(1)) {
      assert.equal(a.hold?.readable, false, `#${a.merge.pr}`);
      assert.match(a.hold.why, /hold/);
    }
  } finally { w.db.close(); }
});

test("what merged is read with what judging it needs: its branches, its title, and its author as GitHub's REST API names one", () => {
  /** @type {string[][]} */ const asked = [];
  const rows = [
    { number: 7, mergedAt: new Date((T - 600) * 1000).toISOString(), headRefOid: sha("a"), mergeCommit: { oid: sha("d") }, baseRefName: "main", headRefName: "feature",
      title: "a pull request", author: { login: "app/merge-policy", is_bot: true } },
    { number: 8, mergedAt: new Date((T - 300) * 1000).toISOString(), headRefOid: sha("b"), mergeCommit: { oid: sha("e") }, baseRefName: "release", headRefName: "fix",
      title: "another", author: { login: "someone", is_bot: false } },
  ];
  const read = (/** @type {any[]} */ list, o = {}) => mergedSince(NWO, T - 900, { until: T, run: (args) => { asked.push(args); return { ok: true, out: JSON.stringify(list) }; }, ...o });
  const got = /** @type {any[]} */ (read(rows, { whole: true }));
  assert.match(asked[0].join(" "), /--json number,mergedAt,headRefOid,mergeCommit,baseRefName,headRefName,author,title /);
  assert.deepEqual(got.map((m) => [m.pr, m.baseRef, m.headRef, m.title, m.author]),
                   [[7, "main", "feature", "a pull request", "merge-policy[bot]"], [8, "release", "fix", "another", "someone"]]);
  // A person whose login starts as an App's is named in gh isn't one.
  assert.equal(/** @type {any[]} */ (read([{ ...rows[1], author: { login: "app/le", is_bot: false } }], { whole: true }))[0].author, "app/le");
  // One with no base named vouches for nothing.
  assert.match(/** @type {any} */ (read([{ ...rows[0], baseRefName: "" }], { whole: true })).why ?? "", /no base named/);
  // Unasked, none of it is read, and the read is the one the trial's report makes.
  const plain = /** @type {any[]} */ (read(rows));
  assert.match(asked.at(-1)?.join(" ") ?? "", /--json number,mergedAt,headRefOid,mergeCommit --limit/);
  assert.deepEqual(Object.keys(plain[0]).sort(), ["head", "mergeCommit", "mergedAt", "pr"]);
});

test("a tick judges what merged since its last look, and a look that fails doesn't fail the tick", async () => {
  const now = Math.floor(Date.now() / 1000);
  /** @type {any[]} */ const judgedWith = [];
  const out = await run({ keepDir: true, evaluate: () => ({ ok: false, why: "not this test's" }),
                          mergedSince: () => [{ pr: 7, mergedAt: now - 600, head: sha("a"), mergeCommit: sha("d"), baseRef: "main", headRef: "feature", author: "someone", title: "t" }],
                          judgeAtMerge: (/** @type {any} */ a) => { judgedWith.push(a); return verdict("PASS"); } });
  assert.match(out.log, /merged #7: judged as it stood at its merge[^\n]*PASS/);
  assert.equal(judgedWith[0].nwo, "o/r");
  const db = open(out.dbPath);
  try {
    const kept = /** @type {any[]} */ (db.prepare("SELECT seq, payload FROM event WHERE op = ?").all(MERGE_JUDGED));
    assert.equal(kept.length, 1);
    // Kept by what judged it, as the tick's own records are, and before the tick's end is recorded.
    const tickEnd = /** @type {any} */ (db.prepare("SELECT seq, payload FROM event WHERE op = 'daemon.tick'").get());
    assert.deepEqual(JSON.parse(kept[0].payload).code, JSON.parse(tickEnd.payload).code);
    assert.equal(JSON.parse(kept[0].payload).policy, JSON.parse(tickEnd.payload).policy);
    assert.ok(kept[0].seq < tickEnd.seq, "within the tick");
  } finally { db.close(); }
  // A look that throws is said, and the tick ends as any other.
  /** @type {any} */ let thrown = null;
  await assert.doesNotReject(async () => { thrown = await run({ evaluate: () => ({ ok: false, why: "not this test's" }), mergedSince: () => { throw new Error("gh isn't there"); } }); },
                             "a look that throws doesn't fail the tick");
  assert.match(thrown.log, /merges: judging what merged failed[^\n]*gh isn't there/);
  assert.equal(thrown.r.halted, false);
  // Unread, as GitHub out of reach leaves it, none is judged and the tick says why.
  const offline = await run({ evaluate: () => ({ ok: false, why: "not this test's" }) });
  assert.match(offline.log, /merges: what merged since[^\n]*couldn't be read/);
});
