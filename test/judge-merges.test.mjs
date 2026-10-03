// Each merge judged as a tick ends (#342): what merged since the last look is
// judged once, as it stood at its merge, and kept as its own event, so a merge
// between two ticks, or while the daemon was down, isn't missed.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { open } from "../src/db/ops.mjs";
import { tick } from "../src/daemon.mjs";
import { OFFLINE_READS } from "./fixtures/offline-github.mjs";
import { run } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

/** The module, or why it can't be had. */
const M = await import("../src/merges.mjs").catch((err) => ({ judgeMerges: () => assert.fail(`src/merges.mjs: ${err}`), MERGE_JUDGED: "", MERGES_LOOKED: "",
                                                               FIRST_LOOK_SECONDS: NaN, JUDGED_A_TICK: NaN, AGAIN_FOR_SECONDS: NaN }));
const { judgeMerges, MERGE_JUDGED, MERGES_LOOKED, FIRST_LOOK_SECONDS, JUDGED_A_TICK, AGAIN_FOR_SECONDS } = M;
/** The event a merge's first judgment that didn't settle is kept as, or a name no event has while the source has none. */
const MERGE_TRIED = /** @type {any} */ (M).MERGE_TRIED ?? "no such event yet";
/** How long before now a look takes GitHub to have listed every merge, or none while the source says none. */
const LAG = /** @type {any} */ (M).LISTED_WITHIN_SECONDS ?? 0;
/** The read of what merged, or one that reads nothing while the source has none. */
const mergedList = /** @type {any} */ (M).mergedList ?? (() => ({ why: "src/merges.mjs has no mergedList" }));
const PAGES_AT_MOST = /** @type {any} */ (M).PAGES_AT_MOST ?? 0;

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
    assert.deepEqual(w.asked[0], { nwo: NWO, since: T - FIRST_LOOK_SECONDS, until: T });
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
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - LAG], "every merge GitHub has had time to list is judged");
    // The next look starts where this one reached, and judges none again, though GitHub lists it again.
    assert.deepEqual(w.look(T + 300, [merge(8, 300, { head: sha("b"), mergeCommit: sha("e") })]), { ok: true, judged: 0, waiting: 0 });
    assert.equal(w.asked[1].since, T - LAG);
    assert.equal(w.judgedWith.length, 2, "none judged twice");
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - LAG, T + 300 - LAG]);
    // One merged again at another head, reopened it can't be, but the same number re-listed with another head is another merge.
    assert.equal(/** @type {any} */ (w.look(T + 600, [merge(8, -500, { head: sha("c") })])).judged, 1);
  } finally { w.db.close(); }
});

test("one tick judges only so many, the oldest first, and the look reaches no further than the earliest left", () => {
  const w = world();
  try {
    const five = [5, 4, 3, 2, 1].map((n) => merge(n, n * 1000));
    const got = w.look(T, five);
    assert.deepEqual(got, { ok: true, judged: JUDGED_A_TICK, waiting: 5 - JUDGED_A_TICK });
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:5", "pr:4", "pr:3"]);
    // The earliest left merged at T - 2000: every merge before that second is judged.
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - 2001]);
    assert.match(w.said.join("\n"), /3 judged[^\n]*2 left for the next tick/);
    // The next tick asks from there, and judges the rest.
    assert.deepEqual(w.look(T + 300, five), { ok: true, judged: 2, waiting: 0 });
    assert.equal(w.asked[1].since, T - 2001);
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:5", "pr:4", "pr:3", "pr:2", "pr:1"]);
    assert.equal(w.events(MERGES_LOOKED).at(-1).upTo, T + 300 - LAG);
  } finally { w.db.close(); }
});

test("a merge GitHub lists only some minutes after it happened is still judged: a look reaches to a little before now", () => {
  const w = world();
  try {
    assert.ok(LAG >= 300, `GitHub's search lists a merge after it happens: ${LAG}`);
    // Merged a minute before the look, and not listed yet.
    w.look(T, []);
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - LAG]);
    // Listed by the next look, which asks from before it.
    const listed = (/** @type {number} */ since) => (T - 60 >= since ? [merge(7, 60)] : []);
    assert.deepEqual(w.look(T + 300, listed), { ok: true, judged: 1, waiting: 0 });
    // And the look never goes back for it: the first reaches no further back than it started.
    const first = world();
    try {
      first.look(T, [], undefined, {});
      assert.ok(first.events(MERGES_LOOKED)[0].upTo >= T - Math.max(LAG, FIRST_LOOK_SECONDS));
    } finally { first.db.close(); }
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
      const young = [merge(7, 1600), merge(8, 1300)];
      assert.deepEqual(w.look(T, young, (m) => (m.pr === 7 ? judge(m) : verdict("PASS"))), { ok: true, judged: 1, waiting: 1 }, what);
      assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:8"], `${what}: not kept, and the one after it is`);
      assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - 1601], `${what}: the look stops before it`);
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
      // The one left holds the look before it, however far on now is.
      assert.equal(stuck.events(MERGES_LOOKED).at(-1).upTo, T - 601, what);
      assert.deepEqual(stuck.look(T + AGAIN_FOR_SECONDS, [merge(7, 600)], judge), { ok: true, judged: 1, waiting: 0 }, what);
      assert.equal(stuck.events(MERGE_JUDGED)[0].state, "UNKNOWN", what);
      assert.equal(stuck.events(MERGES_LOOKED).at(-1).upTo, T + AGAIN_FOR_SECONDS - LAG);
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
    const from = T - LAG;
    // Merged in the very second the last look reached to, and left.
    const m = merge(7, LAG);
    w.look(T + 300, [m], () => verdict("UNKNOWN", "retry"));
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [from, from], "not a second further back each tick");
    w.look(T + 600, [m], () => verdict("PASS"));
    assert.equal(w.asked.at(-1).since, from, "and it's asked from there, the merge's own second within it");
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
    assert.deepEqual(w.events(MERGES_LOOKED).map((e) => e.upTo), [T - LAG], "no look kept for it");
    assert.match(w.said.join("\n"), /couldn't be read[^\n]*HTTP 502/);
    w.look(T + 600, []);
    assert.equal(w.asked.at(-1).since, T - LAG, "from the last look that read");
    // A look that doesn't read, a store's damaged row say, is no look: the first look's reach again.
    w.db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(T + 700, "daemon", MERGES_LOOKED, null, "{not json");
    w.look(T + 900, []);
    assert.equal(w.asked.at(-1).since, T + 900 - FIRST_LOOK_SECONDS);
  } finally { w.db.close(); }
});

test("a halt stops the look: nothing is read or judged once it's seen, and what's left waits for the next", () => {
  const w = world();
  try {
    // Seen before it starts: GitHub isn't asked, and nothing is kept.
    const stopped = w.look(T, [merge(7, 2600), merge(8, 2300)], undefined, { halted: () => true });
    assert.equal(stopped.ok, false);
    assert.match(/** @type {any} */ (stopped).why, /halted/);
    assert.equal(w.asked.length, 0, "what merged isn't read");
    assert.equal(w.judgedWith.length, 0);
    assert.equal(w.db.prepare("SELECT COUNT(*) n FROM event").get().n, 0, "nothing kept");
    // Seen between two merges: the one judged is kept, the rest aren't judged, and no look says they were.
    const midway = w.look(T, [merge(7, 2600), merge(8, 2300)], undefined, { halted: () => w.judgedWith.length >= 1 });
    assert.equal(midway.ok, false);
    assert.deepEqual(w.judgedWith.map((a) => a.merge.pr), [7]);
    assert.deepEqual(w.events(MERGE_JUDGED).map((e) => e.subject), ["pr:7"]);
    assert.deepEqual(w.events(MERGES_LOOKED), [], "the look isn't kept as having reached past what it left");
    // The next look, the halt lifted, judges what was left and not the one judged.
    assert.deepEqual(w.look(T + 300, [merge(7, 2600), merge(8, 2300)]), { ok: true, judged: 1, waiting: 0 });
    assert.deepEqual(w.judgedWith.map((a) => a.merge.pr), [7, 8]);
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
    // One whose author GitHub doesn't give may be the builder's: who opened it is no evidence a builder didn't.
    w.look(T + 300, [merge(10, 100, { author: null })]);
    assert.equal(w.judgedWith.at(-1).hold?.readable, false, "an author that can't be read");
    assert.match(w.judgedWith.at(-1).hold.why, /who opened it/);
  } finally { w.db.close(); }
});

const iso = (/** @type {number} */ t) => new Date(t * 1000).toISOString().replace(/\.\d+Z$/, "Z");
/** A closed pull request as GitHub's list gives one through the read's query: merged `merged` seconds before T, or not at all, and last changed `changed` before T. */
const closed = (/** @type {number} */ number, /** @type {{ merged?: number | null, changed?: number, [k: string]: any }} */ { merged = null, changed, ...over } = {}) =>
  JSON.stringify({ number, merged_at: merged == null ? null : iso(T - merged), updated_at: iso(T - (changed ?? merged ?? 0)), head: sha("a"), mergeCommit: sha("d"),
                   baseRef: "main", headRef: "feature", author: "someone", title: `pull request ${number}`, ...over });
/** What merged since `since`, up to T, read from `pages`: each a list of rows, "fail" for a read that fails, or a function of the page asked and how many reads were made. */
const listed = (/** @type {any} */ pages, since = T - 900) => {
  /** @type {string[]} */ const asked = [];
  const got = mergedList(NWO, since, { until: T, run: (/** @type {string[]} */ args) => {
    asked.push(args.join(" "));
    const n = Number(/[?&]page=(\d+)/.exec(args.join(" "))?.[1]);
    const p = typeof pages === "function" ? pages(n, asked.length) : pages[n - 1];
    return p === "fail" ? { ok: false, out: "", err: "HTTP 502" } : { ok: true, out: (p ?? []).join("\n") };
  } });
  return { got, asked };
};
/** The pull requests a reading holds, which must be a reading: a failed one says why. */
const prsOf = (/** @type {any} */ got) => { assert.ok(Array.isArray(got), `no reading: ${JSON.stringify(got)}`); return got.map((/** @type {any} */ m) => m.pr); };
/** A hundred closed pull requests, none merged, each changed `changed` seconds before T, numbered down from `from`. */
const hundred = (/** @type {number} */ from, /** @type {number} */ changed) => Array.from({ length: 100 }, (_, i) => closed(from - i, { changed }));

test("what merged is read from GitHub's own list of closed pull requests, not its search, each with what judging it needs", () => {
  const { got, asked } = listed([[
    closed(9, { merged: 100 }),
    closed(8, { changed: 200 }),
    closed(7, { merged: 600, changed: 300, author: "merge-policy[bot]", baseRef: "release", headRef: "mp/task-3", head: sha("b"), mergeCommit: sha("e") }),
    closed(6, { merged: 900 }),
    closed(5, { merged: 5000, changed: 400 }),
    closed(4, { merged: -60 }),
    closed(3, { merged: 6000 }),
  ]]);
  assert.ok(Array.isArray(got), JSON.stringify(got));
  // Merged within the time asked, both ends in; the oldest first. Closed unmerged, merged before it, or after it: not one.
  assert.deepEqual(prsOf(got), [6, 7, 9]);
  assert.deepEqual(got[1], { pr: 7, mergedAt: T - 600, head: sha("b"), mergeCommit: sha("e"), baseRef: "release", headRef: "mp/task-3", author: "merge-policy[bot]", title: "pull request 7" });
  // One read: the page ends in a pull request last changed before the time asked, and none merged since lies beyond it.
  assert.equal(asked.length, 1);
  assert.match(asked[0], /^api repos\/o\/r\/pulls\?state=closed&sort=updated&direction=desc&per_page=100&page=1 /);
  assert.doesNotMatch(asked.join("\n"), /search/, "GitHub's search lists a merge some time after it happens, and promises no time");
  // An author GitHub doesn't give is kept as none, for the look to weigh.
  const unnamed = listed([[closed(9, { merged: 100, author: null }), closed(3, { merged: 6000 })]]).got;
  assert.deepEqual(prsOf(unnamed), [9]);
  assert.equal(/** @type {any} */ (unnamed)[0].author, null);
});

test("the list is read page by page until one ends in a pull request last changed before the time asked", () => {
  // A full page all changed since: the next is read too.
  const two = listed([hundred(300, 100), [closed(50, { merged: 700, changed: 500 }), closed(49, { merged: 7000 })]]);
  assert.deepEqual(prsOf(two.got), [50]);
  assert.deepEqual(two.asked.map((a) => /[?&]page=(\d+)/.exec(a)?.[1]), ["1", "2", "1"], "and the first again, for what moved up meanwhile");
  // A full page ending in one changed before it: no more is read.
  const one = listed([[...hundred(300, 100).slice(0, 99), closed(49, { merged: 7000 })], [closed(40, { merged: 700 })]]);
  assert.equal(one.asked.length, 1);
  assert.deepEqual(one.got, []);
  // More pages than a look reads is no reading: a merge may lie beyond them.
  const endless = listed((/** @type {number} */ n) => hundred(100000 - n * 100, 100));
  assert.match(/** @type {any} */ (endless.got).why ?? "", /more than/);
  assert.equal(endless.asked.length, PAGES_AT_MOST);
});

test("a pull request that moves up the list while it's read is still found, and a list changed past telling is no reading", () => {
  const first = hundred(300, 100), second = [closed(50, { merged: 700, changed: 500 }), closed(49, { merged: 7000 })];
  // #77, merged in the time asked and on a page not yet read, is changed while the first is read: it moves to the top, past what was read.
  const moved = listed((/** @type {number} */ n, /** @type {number} */ reads) => (n === 2 ? second : reads === 1 ? first : [closed(77, { merged: 800, changed: 0 }), ...first.slice(0, 99)]));
  assert.deepEqual(prsOf(moved.got), [77, 50]);
  // The first page again holds nothing the look began with: what moved where can't be told.
  const lost = listed((/** @type {number} */ n, /** @type {number} */ reads) => (n === 2 ? second : reads === 1 ? first : hundred(900, 0)));
  assert.match(/** @type {any} */ (lost.got).why ?? "", /changed while it was read/);
});

test("a list that can't be read whole vouches for nothing", () => {
  const why = (/** @type {any} */ pages) => /** @type {any} */ (listed(pages).got).why ?? "";
  assert.match(why(["fail"]), /HTTP 502/);
  assert.match(why([["not json"]]), /doesn't read/);
  assert.match(why([[closed(9, { merged: 100, baseRef: "" })]]), /doesn't read whole/, "a merge with no base named");
  assert.match(why([[closed(9, { merged: 100, head: "abc" })]]), /doesn't read whole/, "a head that's no commit");
  assert.match(why([[closed(9, { merged: 100, mergeCommit: "abc" })]]), /doesn't read whole/, "a merge commit that's none");
  assert.match(why([[JSON.stringify({ number: 9, merged_at: null, updated_at: "when" })]]), /doesn't read whole/, "a time that doesn't read: where the list ends can't be told");
  // A merge GitHub names no commit for is listed, for the look to keep as unjudged.
  const uncommitted = listed([[closed(9, { merged: 100, mergeCommit: null }), closed(3, { merged: 6000 })]]).got;
  assert.deepEqual(prsOf(uncommitted), [9]);
  assert.equal(/** @type {any} */ (uncommitted)[0].mergeCommit, null);
});

test("a tick judges what merged since its last look, and a look that fails doesn't fail the tick", async () => {
  const now = Math.floor(Date.now() / 1000);
  /** @type {any[]} */ const judgedWith = [];
  const out = await run({ keepDir: true, evaluate: () => ({ ok: false, why: "not this test's" }),
                          mergedList: () => [{ pr: 7, mergedAt: now - 600, head: sha("a"), mergeCommit: sha("d"), baseRef: "main", headRef: "feature", author: "someone", title: "t" }],
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
  await assert.doesNotReject(async () => { thrown = await run({ evaluate: () => ({ ok: false, why: "not this test's" }), mergedList: () => { throw new Error("gh isn't there"); } }); },
                             "a look that throws doesn't fail the tick");
  assert.match(thrown.log, /merges: judging what merged failed[^\n]*gh isn't there/);
  assert.equal(thrown.r.halted, false);
  // A halt that arrives late in the tick, after its last check, is seen before the look: what merged isn't read.
  const marker = join(tempDir("reeve-judge-merges-halt-"), "HALT");
  let asked = 0;
  const halted = await run({ evaluate: () => ({ ok: false, why: "not this test's" }), haltMarker: marker,
                             runSelfAudit: () => { writeFileSync(marker, "halt\n"); return []; },
                             mergedList: () => { asked++; return []; } });
  assert.equal(asked, 0, "the look didn't start once the halt was there");
  assert.doesNotMatch(halted.log, /merged #/);
  // Unread, as GitHub out of reach leaves it, none is judged and the tick says why.
  const offline = await run({ evaluate: () => ({ ok: false, why: "not this test's" }) });
  assert.match(offline.log, /merges: what merged since[^\n]*couldn't be read/);
});

test("a halt that arrives while the look runs is acted on before the tick ends: what it left passing is withdrawn", async () => {
  const dir = tempDir("reeve-judge-merges-withdraw-");
  /** @type {any[]} */ const withdrawn = [];
  const head = "7".repeat(40);
  const ctx = {
    ...OFFLINE_READS,
    nwo: "acme/widget", profile: { identity: { key: "acme/widget", defaultBranch: "main" }, authority: { policy: "propose_only" },
      ci: { provider: "github-actions", requiredChecks: [] }, watch: { maxWorkers: 1, maxOpenPrs: 20 }, reviewers: [] },
    db: open(join(dir, "s.db")), logPath: join(dir, "log.txt"), haltMarker: join(dir, "HALT"),
    execute: false, shadow: false, running: 0,
    openPrs: () => [7], prState: () => "OPEN",
    evaluate: () => ({ ok: true, pr: 7, state: "open", head, title: "t", headRef: "f7", baseRef: "main", updatedAt: "2026-09-26T10:00:00Z",
                       verdict: { state: "PASS", head, summary: "pass", clauses: [] }, rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
                       checks: { verdict: "GREEN", caused: [], failing: [] }, reviewers: [], threads: { readable: true, total: 0, unresolved: 0, seen: 0 }, settled: { settled: true } }),
    publish: async (/** @type {any} */ args) => ({ ok: true, id: 100, conclusion: "success", name: "merge-policy", head: args.verdict.head }),
    withdraw: async (/** @type {any} */ args) => { withdrawn.push(args); return { ok: true }; },
    observe: () => ({ observations: [], incomplete: false, threads: { readable: true, total: 0, unresolved: 0, seen: 0 } }),
    derivePr: () => ({}), reviewState: () => ({ readable: true, total: 0, open: 0, resolved: 0, unspilledCritical: 0, rounds: 1 }),
    // The halt arrives while GitHub is read for what merged: after the look began, and after every stop before it.
    mergedList: () => { writeFileSync(join(dir, "HALT"), ""); return []; },
  };
  try {
    await tick(ctx);
    assert.ok(withdrawn.some((w) => w.head === head && /halted/.test(w.why)), `the pass the tick left standing is taken back: ${JSON.stringify(withdrawn)}`);
  } finally { ctx.db.close(); }
});
