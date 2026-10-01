// A person's audit of the shadow trial's calls (#294): a sheet to mark each call
// on, the audit recorded with who made it and when, and the trial's condition
// of no false call read from what was recorded.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, fsyncSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { open } from "../src/db/ops.mjs";
import * as trial from "../src/trial.mjs";
import { auditDirFor } from "../src/paths.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { offlineEnv } from "./fixtures/offline-github.mjs";

const REEVE = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "reeve");
const T0 = 1_900_000_000, MIN = 60, HOUR = 3600, R = "o/r";
const sha = (c) => c.repeat(40);
const MARK = "was reeve right? (yes/no)";

/** A store, and a way to put the daemon's events in it. */
function store() {
  const path = join(tempDir("reeve-audit-"), "s.db");
  const db = open(path);
  const put = (at, op, subject, payload = {}) =>
    db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, subject, JSON.stringify(payload));
  const tick = (at) => put(at, "daemon.tick", null);
  const decided = (at, pr, head, state, over = {}) =>
    put(at, "pr.decided", `pr:${pr}`, { head, state, summary: "", action: state === "PASS" ? "WAIT" : "ESCALATE", why: "", clauses: [], ...over });
  const record = (repo, pr = 1, head = sha("a")) => db.prepare(
    "INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)")
    .run(`${repo}#${pr}@${head}`, pr, head, JSON.stringify({ subject: { repo, pr, head } }), T0, T0, 1, 1);
  return { db, path, put, tick, decided, record };
}
/** Ticks every ten minutes, from `from` for `hours`. */
const ticking = (s, from, hours) => { for (let t = from; t <= from + hours * HOUR; t += 10 * MIN) s.tick(t); };

/** Three calls: #5 blocked at a over two ticks, then passed at b, and #6 passed at c; and `more` to add. */
function report(audits, more = (/** @type {any} */ _s) => {}) {
  const s = store();
  ticking(s, T0, 1);
  s.decided(T0 + 1 * MIN, 5, sha("a"), "BLOCK", { summary: "ci blocked", why: "ci: 3 check(s) still in flight" });
  s.decided(T0 + 6 * MIN, 5, sha("a"), "BLOCK", { summary: "ci blocked", why: "ci: 2 check(s) still in flight" });
  s.decided(T0 + 11 * MIN, 5, sha("b"), "PASS");
  s.decided(T0 + 13 * MIN, 6, sha("c"), "PASS");
  more(s);
  const r = trial.trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged: [], audits });
  s.db.close();
  return r;
}
/** The call of pull request `pr` at the head of `c`. */
const callOf = (r, pr, c) => r.toAudit.find((x) => x.pr === pr && x.head === sha(c));
/** An audit of `r`'s calls, each marked by `right(call)`: true, false, or undefined for no mark. */
function audit(r, right, { by = "A. Person", at = T0 + 2 * HOUR } = {}) {
  const marks = new Map();
  for (const c of r.toAudit) { const m = right(c); if (m !== undefined) marks.set(c.id, { right: m, note: m ? "" : "it shouldn't have" }); }
  const made = trial.auditOf(r.toAudit, marks, { repo: R, by, at });
  assert.ok(made.ok, JSON.stringify(made));
  return made.audit;
}
const noFalseCall = (r) => r.conditions.find((c) => /no false call/.test(c.name));
/** The sheet, its empty mark and note at the end of each call's row filled in for the calls `marks` names. */
const fill = (sheet, marks) => sheet.split("\r\n").map((row) => {
  const m = marks[row.split(",")[0]];
  return m === undefined ? row : row.replace(/,,$/, `,${m[0]},${m[1] ?? ""}`);
}).join("\r\n");

/** The sheet with the mark of each call `marks` names set, whatever it carried. */
const fill2 = (/** @type {string} */ sheet, /** @type {Record<string, string>} */ marks) => sheet.split("\r\n").map((row) => {
  const m = marks[row.split(",")[0]];
  return m === undefined ? row : row.replace(/,[^,]*,([^,]*)$/, `,${m},$1`);
}).join("\r\n");

// ── naming a call ────────────────────────────────────────────────────────────

test("a call is named by what makes it one call, the same over the ticks that repeat it, and another for each other commit, verdict, clauses or place", () => {
  const r = report([]);
  const ids = r.toAudit.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "each call its own name");
  assert.ok(ids.every((id) => /^c[0-9a-f]{16}$/.test(id)), `a name a spreadsheet keeps as text: ${ids}`);
  // Another tick repeating #5's block at a, with another reason, keeps its name.
  const later = report([], (s) => s.decided(T0 + 30 * MIN, 5, sha("a"), "BLOCK", { summary: "ci blocked", why: "ci: failing: unit" }));
  assert.equal(callOf(later, 5, "a").id, callOf(r, 5, "a").id);
  assert.equal(callOf(later, 5, "a").ticks, 3, "control: the third tick is the same call");
  const one = { where: "head", pr: 5, head: sha("a"), state: "BLOCK", summary: "ci blocked" };
  const others = [{ ...one, where: "queue" }, { ...one, pr: 6 }, { ...one, head: sha("b") }, { ...one, state: "UNKNOWN" }, { ...one, summary: "threads blocked" }];
  const named = [one, ...others].map((c) => trial.callId(c));
  assert.equal(new Set(named).size, named.length, JSON.stringify(named));
});

// ── the condition, from what was recorded ────────────────────────────────────

test("an audit marking every call right meets the condition, and the trial passes once every other condition holds", () => {
  const s = store();
  ticking(s, T0, 80);
  const merged = [];
  for (let pr = 1; pr <= 10; pr++) { s.decided(T0 + pr * MIN, pr, sha(String(pr % 10)), "PASS"); merged.push({ pr, mergedAt: T0 + pr * MIN + 30, head: sha(String(pr % 10)), mergeCommit: null }); }
  s.decided(T0 + 20 * MIN, 21, sha("b"), "BLOCK", { action: "FIX_CI", why: "failing: unit", clauses: [{ id: "threads", state: "BLOCK" }] });
  merged.push({ pr: 21, mergedAt: T0 + 21 * MIN, head: sha("b"), mergeCommit: null });
  s.decided(T0 + 22 * MIN, 22, sha("c"), "BLOCK", { why: "the branch conflicts with its base" });
  s.db.prepare("INSERT INTO review_round(nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("o/r", 23, "codex", "review:1", "findings", sha("e"), sha("e").slice(0, 10), T0 + 23 * MIN, "v");
  s.db.prepare("INSERT INTO head_seen(nwo,pr,sha,first_seen_at) VALUES(?,?,?,?)").run("o/r", 23, sha("f"), T0 + 24 * MIN);
  s.put(T0 + 1 * MIN + 10, "queue.decided", "pr:1", { head: sha("e"), state: "PASS" });
  merged[0].mergeCommit = sha("e");
  const seeded = [{ name: "good", why: "", must: "PASS", clauses: {}, ran: true, at: T0, got: "PASS", gotClauses: {}, ok: true, detail: "" }];
  const of = (audits) => trial.trialReport(s.db, { repo: R, since: T0, now: T0 + 80 * HOUR, merged, seeded, audits });
  const before = of([]);
  assert.equal(before.ready, true, "control: every condition the records show holds");
  assert.equal(before.passed, false, "control: and it isn't passed before the audit");
  const after = of([audit(before, () => true, { by: "The Founder" })]);
  s.db.close();
  assert.equal(noFalseCall(after).met, true, noFalseCall(after).detail);
  assert.match(noFalseCall(after).detail, /^all 13 call\(s\) audited right, by The Founder$/);
  assert.equal(after.passed, true);
  assert.match(trial.renderTrial(after, R), /the trial has passed/);
});

test("a call marked wrong is a false call, a false pass where it passed and a false block where it didn't, and the condition isn't met, naming it", () => {
  const r = report([]);
  const a = audit(r, (c) => !(c.pr === 5 && c.state === "BLOCK") && c.pr !== 6);
  assert.deepEqual(a.calls.map((c) => [c.pr, c.state, c.mark]).sort(), [[5, "BLOCK", "false block"], [5, "PASS", "right"], [6, "PASS", "false pass"]]);
  const after = report([a]);
  assert.equal(noFalseCall(after).met, false, noFalseCall(after).detail);
  assert.match(noFalseCall(after).detail, /^2 false call\(s\): /);
  assert.match(noFalseCall(after).detail, /#5 BLOCK at aaaaaaaaaa \(false block, by A\. Person\)/);
  assert.match(noFalseCall(after).detail, /#6 PASS at cccccccccc \(false pass, by A\. Person\)/);
  assert.equal(after.ready, false, "a false call is a condition that isn't met");
  assert.match(trial.renderTrial(after, R), /#6 PASS at cccccccccc.*, audited: false pass, by A\. Person/);
});

test("a call not audited, or made since the audit, leaves the condition for a person, and is named", () => {
  const r = report([]);
  assert.equal(noFalseCall(r).detail, "3 call(s) on 2 pull request(s) to audit", "none audited: the list below names them all");
  const partly = report([audit(r, (c) => (c.pr === 6 ? undefined : true))]);
  assert.equal(noFalseCall(partly).met, null, noFalseCall(partly).detail);
  assert.equal(noFalseCall(partly).detail, "2 of 3 call(s) audited, none false; not yet: #6 PASS at cccccccccc");
  // A call made after the audit marked every one then.
  const since = report([audit(r, () => true)], (s) => s.decided(T0 + 40 * MIN, 7, sha("d"), "BLOCK", { summary: "threads blocked" }));
  assert.equal(noFalseCall(since).met, null, noFalseCall(since).detail);
  assert.match(noFalseCall(since).detail, /not yet: #7 BLOCK at dddddddddd$/);
  assert.equal(noFalseCall(report([audit(r, () => true)])).met, true, "control: with every call marked right, it's met");
});

test("a later audit of a call is the one that counts, so a mark corrected stands corrected", () => {
  const r = report([]);
  const wrong = audit(r, (c) => c.pr !== 6, { at: T0 + 2 * HOUR });
  const corrected = audit(r, (c) => (c.pr === 6 ? true : undefined), { at: T0 + 3 * HOUR });
  assert.equal(noFalseCall(report([wrong, corrected])).met, true, "corrected after");
  assert.equal(noFalseCall(report([corrected, wrong])).met, true, "whatever order they're read in");
  assert.equal(noFalseCall(report([wrong])).met, false, "control: the first audit alone has a false call");
});

test("with no call to audit, no audit says there was no false call", () => {
  const s = store();
  ticking(s, T0, 1);
  const r = trial.trialReport(s.db, { repo: R, since: T0, now: T0 + HOUR, merged: [], audits: [] });
  s.db.close();
  assert.equal(noFalseCall(r).met, null, noFalseCall(r).detail);
});

test("audits that can't be read vouch for nothing, and the condition isn't met", () => {
  const r = report([]);
  const unread = report({ why: "the audit recorded in x.json can't be read" });
  assert.equal(noFalseCall(unread).met, false);
  assert.match(noFalseCall(unread).detail, /can't be read, so they vouch for nothing: the audit recorded in x\.json can't be read/);
  assert.equal(noFalseCall(report([audit(r, () => true)])).met, true, "control");
});

// ── keeping the audit ────────────────────────────────────────────────────────

test("an audit is kept with who made it and when, and read back as it was kept", () => {
  const dir = join(tempDir("reeve-audits-"), "audits");
  assert.deepEqual(trial.readAudits(dir, R), { ok: true, audits: [] }, "none recorded yet");
  const r = report([]);
  const first = audit(r, (c) => c.pr !== 6, { at: T0 + 2 * HOUR });
  const second = audit(r, () => true, { by: "Another", at: T0 + 3 * HOUR });
  const { path } = trial.recordAudit(dir, first);
  trial.recordAudit(dir, second);
  assert.ok(existsSync(path), path);
  assert.deepEqual(readdirSync(dir).sort(), ["000001.json", "000002.json"], "each kept, the earlier one too, numbered as recorded");
  const read = trial.readAudits(dir, R);
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual(read.audits.map((a) => [a.by, a.at, a.seq]), [["A. Person", T0 + 2 * HOUR, 1], ["Another", T0 + 3 * HOUR, 2]]);
  const { seq: _seq, ...back } = /** @type {any} */ (read.audits[0]);
  assert.deepEqual(back, first);
});

test("an audit kept that doesn't read whole, or is another repository's, is a fault, not an audit", () => {
  const r = report([]);
  const bad = (/** @type {string} */ text, name = "000002.json") => {
    const dir = join(tempDir("reeve-audits-"), "audits");
    trial.recordAudit(dir, audit(r, () => true));
    writeFileSync(join(dir, name), text);
    return trial.readAudits(dir, R);
  };
  assert.match(JSON.stringify(bad("{not json")), /000002\.json can't be read/);
  const whole = audit(r, () => true);
  assert.match(JSON.stringify(bad(JSON.stringify({ ...whole, by: "" }))), /000002\.json doesn't read whole/, "no one named");
  assert.match(JSON.stringify(bad(JSON.stringify({ ...whole, at: "today" }))), /000002\.json doesn't read whole/, "no time");
  assert.match(JSON.stringify(bad(JSON.stringify({ ...whole, calls: [{ ...whole.calls[0], mark: "maybe" }] }))), /000002\.json doesn't read whole/, "a mark that isn't one");
  assert.match(JSON.stringify(bad(JSON.stringify({ ...whole, calls: [{ ...whole.calls[0], to: undefined }] }))), /000002\.json doesn't read whole/, "a mark that says no event it covers");
  assert.match(JSON.stringify(bad(JSON.stringify({ ...whole, repo: "x/y" }))), /000002\.json is of x\/y, not o\/r/);
  // The same call marked twice, right then false: which counts can't be told.
  const twice = { ...whole, calls: [whole.calls[0], { ...whole.calls[0], mark: "false block" }] };
  assert.match(JSON.stringify(bad(JSON.stringify(twice))), new RegExp(`000002\\.json marks call ${whole.calls[0].id} twice`));
  assert.match(JSON.stringify(bad(JSON.stringify(whole), "z.json")), /z\.json, among the audits recorded, isn't one reeve recorded/, "a file reeve didn't number");
  assert.equal(bad(JSON.stringify(whole)).ok, true, "control: a whole one of this repository reads");
  // Where the folder can't be listed, a file in its place say.
  const notDir = join(tempDir("reeve-audits-"), "audits");
  writeFileSync(notDir, "");
  assert.match(JSON.stringify(trial.readAudits(notDir, R)), /the audits recorded in .* can't be listed: ENOTDIR/);
});

// ── the sheet ────────────────────────────────────────────────────────────────

test("the sheet lists every call with its reason and a link to its pull request, and reads back the marks given, as a spreadsheet saves it", () => {
  const r = report([], (s) => s.decided(T0 + 40 * MIN, 7, sha("d"), "BLOCK", { summary: "ci blocked", why: 'failing: "unit", lint' }));
  const sheet = trial.auditSheet(r.toAudit, R);
  assert.ok(sheet.startsWith("\uFEFF"), "marked as UTF-8, for a spreadsheet to read it so");
  const [head, ...rows] = sheet.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);
  assert.deepEqual(head.split(","), ["call", "pull request", "link", "where", "verdict", "reason", "standing when it merged", "ticks", "first seen", "judged to", "marked before", MARK, "note"]);
  assert.equal(rows.length, 4, "a row for each call");
  assert.match(sheet, /,https:\/\/github\.com\/o\/r\/pull\/7,/);
  assert.match(sheet, /"ci blocked: failing: ""unit"", lint"/, "a reason with commas and quotes stays one cell");
  const [five, , six, seven] = [callOf(r, 5, "a"), callOf(r, 5, "b"), callOf(r, 6, "c"), callOf(r, 7, "d")];
  const filled = fill(sheet, { [five.id]: [" Yes"], [six.id]: ["no", "it merged with a failing check"], [seven.id]: ["RIGHT"] });
  const read = trial.readSheet(filled);
  assert.ok(read.ok, JSON.stringify(read));
  assert.deepEqual([...read.marks].sort(), [[five.id, { right: true, note: "", to: five.seq }], [seven.id, { right: true, note: "", to: seven.seq }],
                                            [six.id, { right: false, note: "it merged with a failing check", to: six.seq }]].sort());
  // Saved again with a semicolon between cells, as some spreadsheets do, and with LF line ends.
  const semi = `\uFEFFcall;pull request;judged to;${MARK};note\n${six.id};6;${six.seq};wrong;"a pass; it shouldn't be"\n${five.id};5;${five.seq};;\n`;
  const back = trial.readSheet(semi);
  assert.ok(back.ok, JSON.stringify(back));
  assert.deepEqual([...back.marks], [[six.id, { right: false, note: "a pass; it shouldn't be", to: six.seq }]], "a row with no mark is a call not audited");
  // Tab-separated, as a sheet copied out of a spreadsheet is.
  assert.deepEqual([...(/** @type {any} */ (trial.readSheet(`call\tjudged to\t${MARK}\tnote\n${seven.id}\t${seven.seq}\tno\t\n`))).marks], [[seven.id, { right: false, note: "", to: seven.seq }]]);
});

test("the sheet writes a reason that a spreadsheet would read as a formula as text", () => {
  const r = report([], (s) => s.decided(T0 + 40 * MIN, 7, sha("d"), "BLOCK", { summary: "=HYPERLINK(\"http://x\")", why: "" }));
  const sheet = trial.auditSheet(r.toAudit, R);
  assert.match(sheet, /,"'=HYPERLINK\(""http:\/\/x""\)",/);
  assert.doesNotMatch(sheet, /,"?=HYPERLINK/);
});

test("a sheet already audited carries each call's mark and note, for a person to add to", () => {
  const r0 = report([]);
  const r = report([audit(r0, (c) => (c.pr === 6 ? false : c.state === "BLOCK" ? true : undefined))]);
  const sheet = trial.auditSheet(r.toAudit, R);
  const row = (c) => sheet.split("\r\n").find((x) => x.startsWith(c.id + ",")) ?? "";
  assert.match(row(callOf(r, 6, "c")), /,no,it shouldn't have$/);
  assert.match(row(callOf(r, 5, "a")), /,yes,$/);
  assert.match(row(callOf(r, 5, "b")), /,,$/, "one not audited is left to mark");
});

test("a mark that isn't yes or no, a call marked twice two ways, or a sheet that isn't one is refused, not read", () => {
  const r = report([]);
  const sheet = trial.auditSheet(r.toAudit, R);
  const six = callOf(r, 6, "c");
  const maybe = trial.readSheet(fill(sheet, { [six.id]: ["maybe"] }));
  assert.equal(maybe.ok, false);
  assert.match(/** @type {any} */ (maybe).why, new RegExp(`${six.id}.*"maybe".*yes or no`));
  const twice = trial.readSheet(`call,judged to,${MARK},note\r\n${six.id},${six.seq},yes,\r\n${six.id},${six.seq},no,\r\n`);
  assert.equal(twice.ok, false);
  assert.match(JSON.stringify(twice), /marked twice/);
  assert.equal(trial.readSheet(`call,judged to,${MARK},note\r\n${six.id},${six.seq},yes,\r\n${six.id},${six.seq},Yes,\r\n`).ok, true, "control: twice alike is one mark");
  // Without the event each call was judged to, a mark can't say what it saw.
  assert.match(JSON.stringify(trial.readSheet(`call,${MARK},note\r\n${six.id},yes,\r\n`)), /isn't an audit sheet/);
  assert.match(String(/** @type {any} */ (trial.readSheet(`call,judged to,${MARK},note\r\n${six.id},soon,yes,\r\n`)).why), /"judged to" isn't an event of the store/);
  const none = trial.readSheet("a,b,c\r\n1,2,3\r\n");
  assert.equal(none.ok, false);
  assert.match(JSON.stringify(none), /isn't an audit sheet/);
});

test("an audit is taken only of calls the trial lists, as the report lists them, whatever else the sheet says, and names who made it", () => {
  const r = report([]);
  const six = callOf(r, 6, "c");
  // The sheet's verdict column for #6 says BLOCK; the report's PASS is what's recorded.
  const sheet = trial.auditSheet(r.toAudit, R).replace(`${six.id},6,https://github.com/o/r/pull/6,head,PASS,`, `${six.id},6,https://github.com/o/r/pull/6,head,BLOCK,`);
  assert.match(sheet, new RegExp(`${six.id},6,[^,]+,head,BLOCK,`), "control: the sheet was changed");
  const read = /** @type {any} */ (trial.readSheet(fill(sheet, { [six.id]: ["no"] })));
  const made = /** @type {any} */ (trial.auditOf(r.toAudit, read.marks, { repo: R, by: "A. Person", at: T0 }));
  assert.ok(made.ok, JSON.stringify(made));
  assert.deepEqual(made.audit.calls.map((c) => [c.pr, c.head, c.state, c.mark]), [[6, sha("c"), "PASS", "false pass"]]);
  assert.equal(made.audit.repo, R);
  const stray = trial.auditOf(r.toAudit, new Map([["c0123456789abcdef", { right: true, note: "" }]]), { repo: R, by: "A. Person", at: T0 });
  assert.match(JSON.stringify(stray), /marks 1 call\(s\) this trial doesn't list \(c0123456789abcdef\)/);
  const nothing = trial.auditOf(r.toAudit, new Map(), { repo: R, by: "A. Person", at: T0 });
  assert.match(JSON.stringify(nothing), /marks no call/);
  const nobody = trial.auditOf(r.toAudit, read.marks, { repo: R, by: "  ", at: T0 });
  assert.match(JSON.stringify(nobody), /names who made it/);
});

// ── reeve trial ──────────────────────────────────────────────────────────────

/** A reeve to run, with a home of its own and a gh that answers that nothing merged. */
function reeveWith() {
  const bin = tempDir("reeve-audit-gh-");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n  "pr list") printf '%s' '[]' ;;\n  *) echo "not a read this test answers: $*" >&2; exit 1 ;;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const home = tempDir("reeve-audit-home-");
  mkdirSync(join(home, "credentials"), { recursive: true, mode: 0o700 });
  const env = { ...offlineEnv(), PATH: `${bin}:${offlineEnv().PATH}`, REEVE_HOME: home };
  return { home, run: (...args) => spawnSync(process.execPath, [REEVE, ...args], { encoding: "utf8", env }) };
}

test("reeve trial writes the audit sheet, records the one a person filled in under their name, and reads it back in each report", () => {
  const start = Math.floor(Date.now() / 1000) - 3 * HOUR;
  const since = new Date(start * 1000).toISOString();
  const s = store();
  ticking(s, start, 2);
  s.decided(start + 5 * MIN, 7, sha("a"), "PASS");
  s.decided(start + 9 * MIN, 8, sha("b"), "BLOCK", { summary: "ci blocked", why: "failing: unit" });
  s.record(R, 7, sha("a"));
  s.db.close();
  const { home, run } = reeveWith();
  const dir = tempDir("reeve-audit-sheet-");
  const sheetPath = join(dir, "calls.csv");
  const made = run("trial", R, "--db", s.path, "--since", since, "--audit-sheet", sheetPath);
  assert.equal(made.status, 1, "not passed: " + made.stderr);
  assert.match(made.stderr, /audit sheet written to .*calls\.csv: 2 call\(s\), 0 marked already/);
  const sheet = readFileSync(sheetPath, "utf8");
  assert.match(sheet, /https:\/\/github\.com\/o\/r\/pull\/8/);
  const again = run("trial", R, "--db", s.path, "--since", since, "--audit-sheet", sheetPath);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /won't write over .*calls\.csv/);
  assert.equal(readFileSync(sheetPath, "utf8"), sheet, "and the sheet is as it was");
  // Every call marked right.
  const ids = sheet.replace(/^\uFEFF/, "").split("\r\n").slice(1).filter(Boolean).map((x) => x.split(",")[0]);
  writeFileSync(sheetPath, fill(sheet, Object.fromEntries(ids.map((id) => [id, ["yes"]]))));
  const named = run("trial", R, "--db", s.path, "--since", since, "--by", "The Founder");
  assert.equal(named.status, 2, named.stderr);
  assert.match(named.stderr, /without --audited nothing is recorded/, "a name with no sheet isn't taken for an audit");
  const nobody = run("trial", R, "--db", s.path, "--since", since, "--audited", sheetPath);
  assert.equal(nobody.status, 2, nobody.stderr);
  assert.match(nobody.stderr, /pass --by with their name/);
  assert.equal(existsSync(join(home, "audits")), false, "nothing recorded without a name");
  const recorded = run("trial", R, "--db", s.path, "--since", since, "--audited", sheetPath, "--by", "The Founder");
  assert.match(recorded.stderr, /audit recorded in .*: 2 call\(s\) marked by The Founder/);
  assert.match(recorded.stdout, /met +no false call on audit: all 2 call\(s\) audited right, by The Founder/);
  const kept = readdirSync(join(home, "audits", "o", "r")).filter((f) => f.endsWith(".json"));
  assert.equal(kept.length, 1, `kept under the reeve home: ${kept}`);
  // Recorded again, and the sheet named is the one being recorded: refused before anything is recorded.
  const same = run("trial", R, "--db", s.path, "--since", since, "--audited", sheetPath, "--by", "The Founder", "--audit-sheet", sheetPath);
  assert.equal(same.status, 2, same.stderr);
  assert.match(same.stderr, /won't write over .*calls\.csv/);
  assert.equal(readdirSync(join(home, "audits", "o", "r")).filter((f) => f.endsWith(".json")).length, 1, "and nothing more recorded");
  // A new sheet beside it carries the marks just recorded.
  const next = join(dir, "next.csv");
  const both = run("trial", R, "--db", s.path, "--since", since, "--audited", sheetPath, "--by", "The Founder", "--audit-sheet", next);
  assert.match(both.stderr, /audit recorded in .*000002\.json/);
  assert.match(readFileSync(next, "utf8"), /,yes,/);
  const later = run("trial", R, "--db", s.path, "--since", since, "--json");
  assert.equal(JSON.parse(later.stdout).conditions.find((/** @type {any} */ c) => /no false call/.test(c.name)).met, true, "read back in each report");
  const unknown = run("trial", R, "--db", s.path, "--since", since, "--audited", join(dir, "absent.csv"), "--by", "The Founder");
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /absent\.csv can't be read/);
  for (const flag of ["--by", "--audited", "--audit-sheet"]) {
    const elsewhere = run("replay", R, flag, "x");
    assert.equal(elsewhere.status, 2, `only the trial takes ${flag}: ${elsewhere.stderr}`);
  }
});

test("of two audits recorded in one second, the one recorded after counts, whatever order they're read in", () => {
  const dir = join(tempDir("reeve-audits-"), "audits");
  const r = report([]);
  trial.recordAudit(dir, audit(r, () => true));
  trial.recordAudit(dir, audit(r, (c) => c.pr !== 6));
  const read = /** @type {any} */ (trial.readAudits(dir, R));
  assert.deepEqual(read.audits.map((/** @type {any} */ a) => [a.at, a.seq]), [[T0 + 2 * HOUR, 1], [T0 + 2 * HOUR, 2]], "control: one second, recorded in turn");
  assert.equal(noFalseCall(report([...read.audits].reverse())).met, false, "the later, marking #6 wrong, counts");
  assert.equal(noFalseCall(report(read.audits)).met, false);
});

test("an audit is recorded under the next number, after another that took its number first", () => {
  const dir = join(tempDir("reeve-audits-"), "audits");
  const a = audit(report([]), () => true);
  let raced = false;
  let path;
  try {
    ({ path } = trial.recordAudit(dir, a, { link: (from, to) => {
      if (!raced) { raced = true; writeFileSync(to, JSON.stringify(a)); }
      return linkSync(from, to);
    } }));
  } catch (err) { path = String(/** @type {any} */ (err).code); }
  assert.ok(raced, "control: another took the first number");
  assert.match(String(path), /000002\.json$/);
  assert.deepEqual(JSON.parse(readFileSync(String(path), "utf8")), a);
});

test("an audit is synced before it's said to be recorded, its file before it's linked into place, and its folders after, to the one that held the first made", () => {
  const home = tempDir("reeve-audits-");
  const dir = join(home, "audits", "o", "r");
  /** @type {string[]} */ let done = [];
  const io = {
    fsync: (/** @type {number} */ fd) => { done.push("file"); fsyncSync(fd); },
    link: (/** @type {string} */ from, /** @type {string} */ to) => { done.push("link"); linkSync(from, to); },
    syncDir: (/** @type {string} */ d) => { done.push(`folder ${d}`); } };
  trial.recordAudit(dir, audit(report([]), () => true), io);
  // The first audit made audits, o and r: the home holds the name of the first.
  assert.deepEqual(done, ["file", "link", `folder ${dir}`, `folder ${join(home, "audits", "o")}`, `folder ${join(home, "audits")}`, `folder ${home}`]);
  done = [];
  trial.recordAudit(dir, audit(report([]), () => true), io);
  assert.deepEqual(done, ["file", "link", `folder ${dir}`], "the next made no folder: its own holds its name");
});

test("an audit whose recording fails leaves no file of its own behind", () => {
  const dir = join(tempDir("reeve-audits-"), "audits");
  const failing = () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); };
  assert.throws(() => trial.recordAudit(dir, audit(report([]), () => true), { link: failing }), /EIO/);
  assert.deepEqual(readdirSync(dir), [], "nothing left behind");
});

test("audits of repositories whose names a path would make alike are kept apart, and none outside the audits", () => {
  const home = "/h";
  assert.notEqual(auditDirFor(home, "o/.github"), auditDirFor(home, "o/-github"));
  assert.notEqual(auditDirFor(home, "o/a.b"), auditDirFor(home, "o/a-b"));
  assert.equal(auditDirFor(home, "nextlyhq/nextly"), "/h/audits/nextlyhq/nextly", "an ordinary name is kept as it is");
  assert.ok(auditDirFor(home, "o/..").startsWith("/h/audits/o/"), auditDirFor(home, "o/.."));
  assert.notEqual(auditDirFor(home, "o/.."), "/h/audits/o/..");
});

test("an audit that can't be recorded is refused, and the sheet made for it is taken away", () => {
  const start = Math.floor(Date.now() / 1000) - 3 * HOUR;
  const since = new Date(start * 1000).toISOString();
  const s = store();
  ticking(s, start, 2);
  s.decided(start + 5 * MIN, 7, sha("a"), "PASS");
  s.record(R, 7, sha("a"));
  s.db.close();
  const { home, run } = reeveWith();
  const dir = tempDir("reeve-audit-sheet-");
  const sheetPath = join(dir, "calls.csv");
  assert.equal(run("trial", R, "--db", s.path, "--since", since, "--audit-sheet", sheetPath).status, 1, "control: the sheet is written");
  const sheet = readFileSync(sheetPath, "utf8");
  const ids = sheet.replace(/^\uFEFF/, "").split("\r\n").slice(1).filter(Boolean).map((x) => x.split(",")[0]);
  writeFileSync(sheetPath, fill(sheet, Object.fromEntries(ids.map((id) => [id, ["yes"]]))));
  // Its folder can't be made: a file stands where it would be.
  mkdirSync(join(home, "audits", "o"), { recursive: true });
  writeFileSync(join(home, "audits", "o", "r"), "");
  const next = join(dir, "next.csv");
  const r = run("trial", R, "--db", s.path, "--since", since, "--audited", sheetPath, "--by", "The Founder", "--audit-sheet", next);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /the audit couldn't be recorded in .*audits\/o\/r/);
  assert.equal(existsSync(next), false, "no sheet for an audit that wasn't recorded");
  const typed = run("trial", R, "--db", s.path, "--since", since, "--audited", sheetPath, "--by", "The Founder", "--json");
  assert.equal(JSON.parse(typed.stdout).kind, "audit_unrecorded");
});

// ── #307's second review ─────────────────────────────────────────────────────

test("an audit recorded after another counts over it, though the clock went back between them", () => {
  const dir = join(tempDir("reeve-audits-"), "audits");
  const r = report([]);
  trial.recordAudit(dir, audit(r, () => true, { at: T0 + 3 * HOUR }));
  // Recorded after, by a clock an hour behind.
  trial.recordAudit(dir, audit(r, (c) => c.pr !== 6, { at: T0 + 2 * HOUR }));
  const read = /** @type {any} */ (trial.readAudits(dir, R));
  assert.equal(read.audits.length, 2, "control");
  assert.equal(noFalseCall(report(read.audits)).met, false, "the later, marking #6 wrong, counts");
});

test("an audit in place whose folder can't then be synced is recorded, and says it may not outlast a power loss", () => {
  const dir = join(tempDir("reeve-audits-"), "audits");
  /** @type {any} */ let got;
  try { got = trial.recordAudit(dir, audit(report([]), () => true), { syncDir: () => { throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" }); } }); }
  catch (err) { got = { threw: /** @type {any} */ (err).code }; }
  assert.match(String(got.path), /000001\.json$/, JSON.stringify(got));
  assert.match(String(got.unsynced), /EIO/);
  assert.equal(/** @type {any} */ (trial.readAudits(dir, R)).audits.length, 1, "it's there, and read, so recording it again would make two");
});

test("a sheet is written whole before its audit is recorded: one that can't be written records nothing, and one whose audit can't be recorded is taken away", () => {
  const d = tempDir("reeve-audit-sheet-");
  let recorded = 0;
  const fails = (/** @type {string} */ code) => () => { throw Object.assign(new Error(code), { code }); };
  /** @type {any} */ let e1, e2, e3;
  try { trial.sheetThenRecord(join(d, "a.csv"), "x", () => recorded++, { write: fails("ENOSPC") }); } catch (e) { e1 = e; }
  assert.equal(e1?.stage, "sheet", String(e1));
  assert.equal(recorded, 0, "nothing recorded");
  assert.equal(existsSync(join(d, "a.csv")), false, "and no sheet left");
  try { trial.sheetThenRecord(join(d, "b.csv"), "x", fails("EIO")); } catch (e) { e2 = e; }
  assert.equal(e2?.stage, "record", String(e2));
  assert.equal(existsSync(join(d, "b.csv")), false, "no sheet for an audit that wasn't recorded");
  writeFileSync(join(d, "c.csv"), "mine");
  try { trial.sheetThenRecord(join(d, "c.csv"), "x", () => recorded++); } catch (e) { e3 = e; }
  assert.equal(e3?.code, "EEXIST", String(e3));
  assert.equal(readFileSync(join(d, "c.csv"), "utf8"), "mine", "a file there is left as it was");
  assert.equal(recorded, 0);
  assert.equal(trial.sheetThenRecord(join(d, "d.csv"), "x", () => "kept"), "kept", "control");
  assert.equal(readFileSync(join(d, "d.csv"), "utf8"), "x");
});

test("a call is named for its repository too, so a sheet of a fork's calls isn't taken for its upstream's", () => {
  const one = { where: "head", pr: 5, head: sha("a"), state: "BLOCK", summary: "ci blocked" };
  assert.notEqual(trial.callId({ ...one, repo: "o/r" }), trial.callId({ ...one, repo: "fork/r" }));
  assert.equal(trial.callId({ ...one, repo: "o/r" }), trial.callId({ ...one, repo: "O/R" }), "as GitHub names it, case aside");
  const s = store();
  ticking(s, T0, 1);
  s.decided(T0 + MIN, 5, sha("a"), "BLOCK", { summary: "ci blocked" });
  const of = (/** @type {string} */ repo) => trial.trialReport(s.db, { repo, since: T0, now: T0 + HOUR, merged: [] }).toAudit[0].id;
  const [ours, theirs] = [of("o/r"), of("fork/r")];
  s.db.close();
  assert.notEqual(ours, theirs);
});

// ── #307's third review ──────────────────────────────────────────────────────

test("audits numbered with one missing among them aren't read: what it marked can't be told", () => {
  const dir = join(tempDir("reeve-audits-"), "audits");
  const r = report([]);
  for (let i = 0; i < 3; i++) trial.recordAudit(dir, audit(r, () => true));
  assert.equal(/** @type {any} */ (trial.readAudits(dir, R)).audits.length, 3, "control: three, numbered one to three");
  rmSync(join(dir, "000002.json"));
  assert.match(JSON.stringify(trial.readAudits(dir, R)), /the audits recorded go to 000003\.json, but 000002\.json is missing, so what it marked can't be told/);
  const first = join(tempDir("reeve-audits-"), "audits");
  trial.recordAudit(first, audit(r, () => true));
  trial.recordAudit(first, audit(r, () => true));
  rmSync(join(first, "000001.json"));
  assert.match(JSON.stringify(trial.readAudits(first, R)), /000001\.json is missing/);
  // Numbered otherwise than reeve numbers them, one could stand in for another under the same number.
  const odd = join(tempDir("reeve-audits-"), "audits");
  trial.recordAudit(odd, audit(r, () => true));
  writeFileSync(join(odd, "2.json"), readFileSync(join(odd, "000001.json")));
  assert.match(JSON.stringify(trial.readAudits(odd, R)), /2\.json, among the audits recorded, isn't one reeve recorded/);
});

test("a call judged again since it was marked right is for a person to mark again, and one marked wrong stays a false call", () => {
  const r = report([]);
  const right = audit(r, () => true, { at: T0 + 20 * MIN });
  // #6 judged again twenty minutes after the audit: the same call, on evidence the audit didn't see.
  const again = (/** @type {any} */ s) => s.decided(T0 + 40 * MIN, 6, sha("c"), "PASS");
  const after = report([right], again);
  assert.equal(noFalseCall(after).met, null, noFalseCall(after).detail);
  assert.match(noFalseCall(after).detail, /not yet: #6 PASS at cccccccccc \(judged again since its audit\)$/);
  assert.equal(noFalseCall(report([right])).met, true, "control: not judged again, it's met");
  const wrong = audit(r, (c) => c.pr !== 6, { at: T0 + 20 * MIN });
  assert.equal(noFalseCall(report([wrong], again)).met, false, "a call found false stays false");
  // The sheet leaves it to mark again, saying how it was marked.
  const sheet = trial.auditSheet(after.toAudit, R);
  const row = sheet.split("\r\n").find((x) => x.startsWith(callOf(after, 6, "c").id + ",")) ?? "";
  assert.match(row, /,"?yes, judged again since"?,,$/);
});

test("a sheet records only the marks a person gave or changed, not those it carried from an audit, so a stale sheet doesn't undo a correction", () => {
  const r0 = report([]);
  const first = audit(r0, () => true, { at: T0 + 2 * HOUR });
  // Two sheets made from the first audit, every call carried as right.
  const r1 = report([first]);
  const sheet = trial.auditSheet(r1.toAudit, R);
  const [fiveB, six] = [callOf(r1, 5, "b"), callOf(r1, 6, "c")];
  // One person corrects #6, and records it.
  const theirs = /** @type {any} */ (trial.readSheet(fill2(sheet, { [six.id]: "no" })));
  assert.deepEqual([...theirs.marks.keys()], [six.id], "only the mark changed is read");
  const correction = /** @type {any} */ (trial.auditOf(r1.toAudit, theirs.marks, { repo: R, by: "X", at: T0 + 3 * HOUR })).audit;
  // Another, from their own copy of the sheet, marks #5 at b wrong, #6 left as it was carried.
  const mine = /** @type {any} */ (trial.readSheet(fill2(sheet, { [fiveB.id]: "no" })));
  assert.deepEqual([...mine.marks.keys()], [fiveB.id]);
  const later = /** @type {any} */ (trial.auditOf(r1.toAudit, mine.marks, { repo: R, by: "Y", at: T0 + 4 * HOUR })).audit;
  const after = report([first, correction, later]);
  assert.match(noFalseCall(after).detail, /#6 PASS at cccccccccc \(false pass, by X\)/, "the correction stands");
  assert.match(noFalseCall(after).detail, /#5 PASS at bbbbbbbbbb \(false pass, by Y\)/);
  // A sheet that changes nothing it carried marks nothing.
  const none = /** @type {any} */ (trial.readSheet(sheet));
  assert.equal(none.marks.size, 0);
  assert.match(JSON.stringify(trial.auditOf(r1.toAudit, none.marks, { repo: R, by: "Z", at: T0 })), /marks no call/);
});

test("a sheet is put in place whole: nothing is at its name until it's written, synced and its folder synced, before its audit is recorded", () => {
  const d = tempDir("reeve-audit-sheet-");
  const at = join(d, "calls.csv");
  /** @type {string[]} */ const done = [];
  try {
    trial.sheetThenRecord(at, "x", () => { done.push(`record ${existsSync(at)}`); }, {
      write: (fd, text) => { done.push(`write ${existsSync(at)}`); writeFileSync(fd, text); },
      syncDir: (dir) => { done.push(`folder ${dir === d} ${existsSync(at)}`); } });
  } catch (err) { done.push(`threw ${/** @type {any} */ (err).code}`); }
  assert.deepEqual(done, ["write false", "folder true true", "record true"]);
  assert.equal(readFileSync(at, "utf8"), "x");
  assert.deepEqual(readdirSync(d), ["calls.csv"], "its own file gone");
});

// ── #307's fourth review ─────────────────────────────────────────────────────

test("a sheet's marks cover each call as judged to when it was made, so one judged again before the sheet is recorded is left to mark again", () => {
  const r = report([]);
  const sheet = trial.auditSheet(r.toAudit, R);
  const six = callOf(r, 6, "c");
  const again = (/** @type {any} */ s) => s.decided(T0 + 40 * MIN, 6, sha("c"), "PASS");
  const now = report([], again);
  assert.ok(callOf(now, 6, "c").seq > six.seq, "control: judged again since the sheet was made");
  const read = /** @type {any} */ (trial.readSheet(fill(sheet, Object.fromEntries(r.toAudit.map((c) => [c.id, ["yes"]])))));
  const made = /** @type {any} */ (trial.auditOf(now.toAudit, read.marks, { repo: R, by: "A. Person", at: T0 + 50 * MIN }));
  assert.equal(made.audit.calls.find((/** @type {any} */ c) => c.id === six.id).to, six.seq, "its mark recorded as covering it to where the sheet saw it");
  const after = report([made.audit], again);
  assert.equal(noFalseCall(after).met, null, noFalseCall(after).detail);
  assert.match(noFalseCall(after).detail, /not yet: #6 PASS at cccccccccc \(judged again since its audit\)$/);
});

test("a call judged again after its audit is so by the store's order of events, though its clock reads no later than the audit's", () => {
  const r = report([]);
  const right = audit(r, () => true, { at: T0 + 30 * MIN });
  // Judged again after the audit, by a clock that reads ten minutes before it.
  const after = report([right], (s) => s.decided(T0 + 20 * MIN, 6, sha("c"), "PASS"));
  assert.equal(noFalseCall(after).met, null, noFalseCall(after).detail);
  assert.match(noFalseCall(after).detail, /#6 PASS at cccccccccc \(judged again since its audit\)/);
  assert.equal(noFalseCall(report([right])).met, true, "control: not judged again, it's met");
});
