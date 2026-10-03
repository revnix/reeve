// The trial counts a merge by its judgment as it stood at its merge (#342),
// where the daemon made one: a merge between two ticks, or while the daemon
// was down, is judged after it rather than missed (the founder, 2026-10-02).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { open } from "../src/db/ops.mjs";
import * as trial from "../src/trial.mjs";
import { MERGE_JUDGED } from "../src/status.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const T0 = 1_900_000_000, MIN = 60, HOUR = 3600, R = "o/r";
const sha = (/** @type {string} */ c) => c.repeat(40);
const CODE = { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false };

/** A store, and a way to put the daemon's events in it. */
function store() {
  const db = open(join(tempDir("reeve-trial-merges-"), "s.db"));
  const put = (/** @type {number} */ at, /** @type {string} */ op, /** @type {string | null} */ subject, payload = {}) =>
    Number(db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, subject, JSON.stringify(payload)).lastInsertRowid);
  const tick = (/** @type {number} */ at) => put(at, "daemon.tick", null, { code: CODE, policy: "p1" });
  const decided = (/** @type {number} */ at, /** @type {number} */ pr, /** @type {string} */ head, /** @type {string} */ state, over = {}) =>
    put(at, "pr.decided", `pr:${pr}`, { head, state, summary: "", action: state === "PASS" ? "WAIT" : "ESCALATE", why: "", clauses: [], ...over });
  /** A merge's judgment, made at `at` as it stood at its merge. */
  const late = (/** @type {number} */ at, /** @type {{ pr: number, head: string, mergedAt: number }} */ m, /** @type {string} */ state, over = {}) =>
    put(at, MERGE_JUDGED, `pr:${m.pr}`, { head: m.head, mergedAt: m.mergedAt, mergeCommit: sha("d"), baseRef: "main", state,
                                           summary: state === "PASS" ? "every clause satisfied at this revision" : state === "BLOCK" ? "mergeable blocked" : "ci could not be determined",
                                           clauses: [], code: CODE, policy: "p1", ...over });
  return { db, put, tick, decided, late };
}
/** Ticks every ten minutes, from `from` for `hours`. */
const ticking = (/** @type {ReturnType<typeof store>} */ s, /** @type {number} */ from, /** @type {number} */ hours) => { for (let t = from; t <= from + hours * HOUR; t += 10 * MIN) s.tick(t); };
const merge = (/** @type {number} */ pr, /** @type {number} */ after, /** @type {string} */ head) => ({ pr, mergedAt: T0 + after, head: sha(head), mergeCommit: sha("d") });
const covered = (/** @type {any} */ r) => r.conditions.find((/** @type {any} */ c) => /every merge judged/.test(c.name));
const byPr = (/** @type {any} */ r, /** @type {number} */ pr) => r.merges.find((/** @type {any} */ m) => m.pr === pr);

test("a merge judged as it stood at its merge counts by that judgment: one merged while the daemon was down, or between two ticks, isn't missed", () => {
  const s = store();
  // Running for two hours, down for two, then running again.
  ticking(s, T0, 2);
  ticking(s, T0 + 4 * HOUR, 1);
  const down = merge(1, 3 * HOUR, "a"), between = merge(2, 65 * MIN, "b"), unjudged = merge(3, 3 * HOUR + 60, "c"), unknown = merge(4, 3 * HOUR + 120, "e");
  s.late(T0 + 4 * HOUR + 60, down, "PASS");
  s.late(T0 + 70 * MIN + 30, between, "BLOCK");
  s.late(T0 + 4 * HOUR + 60, unknown, "UNKNOWN", { kind: "person" });
  const r = trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 5 * HOUR, merged: [between, down, unjudged, unknown] });
  s.db.close();
  assert.deepEqual([byPr(r, 1).state, byPr(r, 1).missed, byPr(r, 1).atMerge], ["PASS", null, true], "merged while down, judged after it");
  assert.deepEqual([byPr(r, 2).state, byPr(r, 2).missed, byPr(r, 2).atMerge], ["BLOCK", null, true], "merged between two ticks, its final head never judged before it");
  assert.equal(r.passedFinal, 1, "the pass counts, the block doesn't");
  // One with no judgment, or an unknown one, is still missed, and says which.
  assert.match(byPr(r, 3).missed, /while the daemon was down/);
  assert.equal(byPr(r, 3).atMerge, false);
  assert.match(byPr(r, 4).missed, /while the daemon was down[^]*unknown/);
  assert.equal(byPr(r, 4).state, null, "an unknown judgment is no verdict of it");
  assert.equal(covered(r).met, false);
  assert.match(covered(r).detail, /^2 of 4 missed: #3 [^]*#4 /);
  assert.match(trial.renderTrial(r, R), /#1 at aaaaaaaaaa: PASS, judged as it stood at its merge/);
  // With each of them judged, every merge is covered.
  const all = store();
  ticking(all, T0, 2);
  ticking(all, T0 + 4 * HOUR, 1);
  for (const m of [down, between, unjudged, unknown]) all.late(T0 + 4 * HOUR + 60, m, "PASS");
  const whole = trial.trialReport(all.db, { repo: R, since: T0, now: T0 + 5 * HOUR, merged: [between, down, unjudged, unknown] });
  all.db.close();
  assert.equal(covered(whole).met, true, covered(whole).detail);
  assert.equal(whole.passedFinal, 4);
});

test("the judgment at the merge stands over the verdict that stood when it merged, which is kept beside it", () => {
  const s = store();
  ticking(s, T0, 2);
  // Blocked at the last tick before it merged, its checks finishing between that tick and the merge.
  const timing = merge(1, 50 * MIN, "a"), pastRules = merge(2, 55 * MIN, "b"), plain = merge(3, 58 * MIN, "c"), notTold = merge(4, 59 * MIN, "e");
  s.decided(T0 + 40 * MIN, 1, sha("a"), "BLOCK", { record: "the-block's-record" });
  s.late(T0 + 60 * MIN, timing, "PASS");
  // Passing at the last tick, and merged past the base's rules.
  s.decided(T0 + 40 * MIN, 2, sha("b"), "PASS");
  s.late(T0 + 60 * MIN, pastRules, "BLOCK");
  // Judged only before it merged: as it always was.
  s.decided(T0 + 40 * MIN, 3, sha("c"), "PASS", { record: "the-pass's-record" });
  // An unknown judgment at the merge says nothing, and the verdict that stood stands.
  s.decided(T0 + 40 * MIN, 4, sha("e"), "PASS");
  s.late(T0 + 60 * MIN, notTold, "UNKNOWN", { kind: "person" });
  const r = trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 2 * HOUR, merged: [timing, pastRules, plain, notTold] });
  s.db.close();
  assert.deepEqual([byPr(r, 1).state, byPr(r, 1).stood, byPr(r, 1).atMerge], ["PASS", "BLOCK", true]);
  assert.deepEqual([byPr(r, 2).state, byPr(r, 2).stood, byPr(r, 2).atMerge], ["BLOCK", "PASS", true]);
  assert.deepEqual([byPr(r, 3).state, byPr(r, 3).stood, byPr(r, 3).atMerge], ["PASS", "PASS", false]);
  assert.deepEqual([byPr(r, 4).state, byPr(r, 4).stood, byPr(r, 4).atMerge, byPr(r, 4).missed], ["PASS", "PASS", false, null]);
  assert.equal(r.passedFinal, 3, "#1, #3 and #4: a merge past the rules isn't one that passed");
  // The record a merge is listed with is its verdict's own: none for a judgment at the merge, which keeps none.
  assert.deepEqual([byPr(r, 1).record, byPr(r, 3).record], [null, "the-pass's-record"]);
  const said = trial.renderTrial(r, R);
  assert.match(said, /#1 at aaaaaaaaaa: PASS, judged as it stood at its merge \(BLOCK stood when it merged\)/);
  assert.match(said, /#2 at bbbbbbbbbb: BLOCK, judged as it stood at its merge \(PASS stood when it merged\)/);
  assert.match(said, /#3 at cccccccccc: PASS$/m);
});

test("a judgment is of the merge it names, and of the report's own time", () => {
  const s = store();
  ticking(s, T0, 1);
  const m = merge(1, 3 * HOUR, "a");
  // Another head's, another merge's of the same pull request, another pull request's.
  s.late(T0 + 4 * HOUR, { ...m, head: sha("b") }, "PASS");
  s.late(T0 + 4 * HOUR, { ...m, mergedAt: m.mergedAt - 60 }, "PASS");
  s.late(T0 + 4 * HOUR, { ...m, pr: 2 }, "PASS");
  // One made of another commit than GitHub says it merged as: the base's rules it was judged by were that commit's.
  s.late(T0 + 4 * HOUR, m, "PASS", { mergeCommit: sha("e") });
  const of = (/** @type {any} */ o = {}) => byPr(trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 5 * HOUR, merged: [m], ...o }), 1);
  assert.equal(of().atMerge, false, "none of them is its");
  assert.match(of().missed, /while the daemon was down/);
  // Its own, recorded after the report's time, or after the event the report is read to, isn't in it.
  const seq = s.late(T0 + 6 * HOUR, m, "PASS");
  assert.equal(of().atMerge, false, "recorded after the report's time");
  assert.equal(of({ now: T0 + 7 * HOUR }).atMerge, true, "control: within it");
  assert.equal(of({ now: T0 + 7 * HOUR, upTo: seq - 1 }).atMerge, false, "after the event it's read to");
  s.db.close();
});

test("each judgment at a merge is a call a person audits, and one marked wrong fails the trial", () => {
  const s = store();
  ticking(s, T0, 2);
  const m = merge(7, 50 * MIN, "a"), before = { pr: 8, mergedAt: T0 - HOUR, head: sha("b") };
  s.decided(T0 + 40 * MIN, 7, sha("a"), "BLOCK");
  const seq = s.late(T0 + 60 * MIN, m, "PASS");
  // One of a merge from before the trial began, judged in it, is no call of this trial.
  s.late(T0 + 60 * MIN, before, "PASS");
  const of = (/** @type {any} */ audits) => trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 2 * HOUR, merged: [m], audits });
  const r = of([]);
  const call = r.toAudit.find((/** @type {any} */ c) => c.where === "merge");
  assert.ok(call, JSON.stringify(r.toAudit));
  assert.deepEqual([call.pr, call.head, call.state, call.final, call.seq], [7, sha("a"), "PASS", true, seq]);
  assert.equal(r.toAudit.filter((/** @type {any} */ c) => c.where === "merge").length, 1, "the one merged before the trial isn't listed");
  assert.equal(r.toAudit.length, 2, "beside the block that stood, another call");
  assert.notEqual(call.id, trial.callId({ repo: R, where: "head", pr: 7, head: sha("a"), state: "PASS", summary: call.summary }), "named apart from a call at the head");
  assert.match(trial.renderTrial(r, R), /#7 PASS as it stood at its merge, at aaaaaaaaaa/);
  assert.match(trial.auditSheet(r.toAudit, R), /,merge,PASS,/);
  // Marked, and marked wrong.
  const audit = (/** @type {boolean} */ right) => {
    const marks = new Map(r.toAudit.map((/** @type {any} */ c) => [c.id, { right: c.where === "merge" ? right : true, note: "" }]));
    const made = trial.auditOf(r.toAudit, marks, { repo: R, by: "A. Person", at: T0 + 3 * HOUR, judgment: r.judgment });
    assert.ok(made.ok, JSON.stringify(made));
    return made.audit;
  };
  const noFalseCall = (/** @type {any} */ x) => x.conditions.find((/** @type {any} */ c) => /no false call/.test(c.name));
  assert.equal(noFalseCall(of([audit(true)])).met, true, noFalseCall(of([audit(true)])).detail);
  const wrong = noFalseCall(of([audit(false)]));
  assert.equal(wrong.met, false);
  assert.match(wrong.detail, /#7 PASS as it stood at its merge, at aaaaaaaaaa \(false pass, by A\. Person\)/);
  s.db.close();
});

test("the trial vouches for a merge's judgment only where the code and policy about to enforce made it", () => {
  const s = store();
  s.tick(T0 + 60);
  const m = merge(1, 50 * MIN, "a");
  const ranOn = () => trial.trialRanOn(s.db, { since: T0, until: T0 + 2 * HOUR, code: CODE, policy: "p1" });
  s.late(T0 + 60 * MIN, m, "PASS");
  assert.deepEqual(ranOn(), { ok: true });
  s.late(T0 + 61 * MIN, merge(2, 51 * MIN, "b"), "PASS", { code: { ...CODE, commit: "o".repeat(40) } });
  assert.match(/** @type {any} */ (ranOn()).why ?? "", /1 judgment\(s\) made by other code/);
  s.late(T0 + 62 * MIN, merge(3, 52 * MIN, "c"), "PASS", { code: undefined, policy: undefined });
  assert.match(/** @type {any} */ (ranOn()).why ?? "", /1 judgment\(s\) whose code or policy can't be told/);
  s.db.close();
});

test("an audit of a later period, which saw a merge's judgment made again since, still covers this period's", () => {
  const s = store();
  ticking(s, T0, 4);
  const m = merge(7, 50 * MIN, "a");
  s.late(T0 + 60 * MIN, m, "PASS");
  // Judged again, the same: the call is one, and the later audit saw it to here.
  s.late(T0 + 3 * HOUR, m, "PASS");
  const of = (/** @type {number} */ now, /** @type {any} */ audits) => trial.trialReport(s.db, { repo: R, since: T0, now, merged: [m], audits });
  const later = of(T0 + 4 * HOUR, []);
  const marks = new Map(later.toAudit.map((/** @type {any} */ c) => [c.id, { right: true, note: "" }]));
  const made = trial.auditOf(later.toAudit, marks, { repo: R, by: "A. Person", at: T0 + 5 * HOUR, judgment: later.judgment });
  assert.ok(made.ok, JSON.stringify(made));
  // Read over the shorter period, the judgment the audit saw lies after it, and is found in the store as a merge's.
  const earlier = of(T0 + 2 * HOUR, [/** @type {any} */ (made).audit]);
  s.db.close();
  const call = earlier.toAudit.find((/** @type {any} */ c) => c.where === "merge");
  assert.equal(call?.audited?.mark, "right");
  assert.equal(call?.gone, false, "the judgment its audit saw is in the store");
  assert.equal(earlier.conditions.find((/** @type {any} */ c) => /no false call/.test(c.name))?.met, true);
});

test("an audit of a merge's judgment covers the judgment it saw: one made again under its number, in a store restored from before, is left to mark again", () => {
  const m = merge(7, 50 * MIN, "a");
  /** A store with the merge judged in the first two hours and again in the fourth, each judgment's event holding what's given besides. */
  const judgedIn = (first = {}, second = {}) => {
    const s = store();
    ticking(s, T0, 4);
    // Another pull request's call beside it, whose audit holds throughout.
    s.decided(T0 + 30 * MIN, 8, sha("b"), "BLOCK");
    const seqs = [s.late(T0 + 60 * MIN, m, "PASS", first), s.late(T0 + 3 * HOUR, m, "PASS", second)];
    return { s, seqs, of: (/** @type {number} */ hours, /** @type {any} */ audits) => trial.trialReport(s.db, { repo: R, since: T0, now: T0 + hours * HOUR, merged: [m], audits }) };
  };
  /** Every call of a report marked right, as an audit. */
  const audit = (/** @type {any} */ r) => {
    const marks = new Map(r.toAudit.map((/** @type {any} */ c) => [c.id, { right: true, note: "" }]));
    const made = trial.auditOf(r.toAudit, marks, { repo: R, by: "A. Person", at: T0 + 5 * HOUR, judgment: r.judgment });
    assert.ok(made.ok, JSON.stringify(made));
    return /** @type {any} */ (made).audit;
  };
  const noFalseCall = (/** @type {any} */ x) => x.conditions.find((/** @type {any} */ c) => /no false call/.test(c.name));
  const call = (/** @type {any} */ r) => r.toAudit.find((/** @type {any} */ c) => c.where === "merge");
  const kept = judgedIn();
  // An audit of the first two hours saw the first judgment, and one of all four the second.
  const [early, whole] = [audit(kept.of(2, [])), audit(kept.of(4, []))];
  const marked = (/** @type {any} */ a) => a.calls.find((/** @type {any} */ c) => c.where === "merge");
  assert.deepEqual([marked(early).to, marked(whole).to], kept.seqs);
  assert.match(String(marked(early).record), /^[0-9a-f]{64}$/, "an audit keeps what binds it to the judgment it saw");
  assert.equal(noFalseCall(kept.of(2, [early])).met, true, "control: the judgment it saw is the one held");
  kept.s.db.close();
  // Restored from a snapshot taken before the first judgment, which was then made again
  // under the same number: the same verdict of the same merge, read from other evidence.
  const again = judgedIn({ clauses: [{ id: "ci", state: "PASS", detail: "read again" }] });
  assert.deepEqual(again.seqs, kept.seqs, "the numbers given out again");
  const after = again.of(2, [early]);
  assert.equal(call(after).id, marked(early).id, "the same call, by what names it");
  assert.equal(call(after).gone, true, "the judgment its audit saw isn't the one held");
  assert.equal(noFalseCall(after).met, null);
  assert.match(noFalseCall(after).detail, /^1 of 2 call\(s\) audited, none false; not yet: #7 PASS as it stood at its merge, at aaaaaaaaaa \(its audit saw a judgment this store doesn't hold\)$/);
  again.s.db.close();
  // The same of a judgment after the period read, which the audit of a later period saw it judged to.
  const later = judgedIn({}, { code: { ...CODE, commit: "o".repeat(40) } });
  assert.equal(call(later.of(2, [whole])).gone, true, "made again by other code, under the number an audit of a later period saw");
  later.s.db.close();
});

test("a kind of case shown only by a merge's judgment as it stood is a kind seen", () => {
  const s = store();
  ticking(s, T0, 2);
  // At no head did the daemon see a pass, a failing check or an unresolved thread: each shows only as the merge stood.
  const passed = merge(1, 50 * MIN, "a"), red = merge(2, 51 * MIN, "b"), open = merge(3, 52 * MIN, "c");
  s.decided(T0 + 40 * MIN, 1, sha("a"), "BLOCK");
  // One of a merge from before the trial, judged in it first, isn't this trial's case.
  s.late(T0 + 60 * MIN, { pr: 9, mergedAt: T0 - HOUR, head: sha("f") }, "BLOCK", { clauses: [{ id: "ci", state: "BLOCK", detail: "failing: unit" }, { id: "threads", state: "BLOCK" }] });
  s.late(T0 + 60 * MIN, passed, "PASS");
  // Blocked at its checks with none of them red, a required one skipped say, is no failing CI: as at a head, only a failing check is.
  const skipped = merge(4, 49 * MIN, "e");
  s.late(T0 + 60 * MIN, skipped, "BLOCK", { clauses: [{ id: "ci", state: "BLOCK", detail: "a required check was skipped: Build" }] });
  s.late(T0 + 60 * MIN, red, "BLOCK", { clauses: [{ id: "ci", state: "BLOCK", detail: "failing: unit" }] });
  s.late(T0 + 60 * MIN, open, "BLOCK", { clauses: [{ id: "threads", state: "BLOCK" }] });
  const r = trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 2 * HOUR, merged: [passed, skipped, red, open] });
  assert.equal(r.kinds["a pull request that passes"], 1);
  assert.equal(r.kinds["failing CI"], 2, "the merge with a red check, not the one blocked at its checks before it");
  assert.equal(r.kinds["unresolved threads"], 3);
  assert.equal(r.kinds["a conflict with the base"], null, "a merge can't show a conflict: it merged");
  // Kinds given as the trial was first read are left as given, a kind not seen then with them.
  const given = { ...r.kinds, "failing CI": null };
  assert.equal(trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 2 * HOUR, merged: [passed, red, open], kinds: given }).kinds["failing CI"], null);
  // One seen at a head is named by the pull request that showed it there.
  s.decided(T0 + 45 * MIN, 5, sha("e"), "PASS");
  assert.equal(trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 2 * HOUR, merged: [passed, red, open] }).kinds["a pull request that passes"], 5);
  s.db.close();
});
