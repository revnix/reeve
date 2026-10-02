// The shadow trial checked again on each tick while enforcing (#331). At
// start-up, `reeve run --enforce` enforces only on a passed trial; after it,
// an audit recorded since may mark a call false, or the trial stop holding
// otherwise. Each tick checks it again, the audits as they read then, and one
// that no longer passes turns the daemon to shadow for good, saying why.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as trial from "../src/trial.mjs";
import { open } from "../src/db/ops.mjs";
import { digestOf } from "../src/evidence.mjs";
import { TICK_STARTED } from "../src/status.mjs";
import { run, EVAL } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

/** @type {any} */ const T = trial;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const T0 = 1_900_000_000, MIN = 60, HOUR = 3600, R = "o/r";
const sha = (/** @type {string} */ c) => c.repeat(40);
const CODE = { commit: "c".repeat(40), tree: "t".repeat(40), dirty: false };
const POLICY = "p1";

/**
 * A trial of o/r from T0 that passed, as the daemon records one: 80 hours of
 * ticks, each saying this code and policy, every kind of case judged, each
 * judgment with its record, the merges it covered, a seeded case, and a
 * person's audit marking every call right.
 */
function passedTrial() {
  const db = open(join(tempDir("reeve-trial-rechecked-"), "s.db"));
  const put = (/** @type {number} */ at, /** @type {string} */ op, /** @type {string | null} */ subject, /** @type {any} */ payload) =>
    Number(db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, subject, JSON.stringify(payload)).lastInsertRowid);
  const ran = { code: CODE, policy: POLICY };
  for (let t = T0; t <= T0 + 80 * HOUR; t += 10 * MIN) { put(t, TICK_STARTED, null, ran); put(t + 1, "daemon.tick", null, ran); }
  /** A judgment of `pr` at `head`, its record kept under its digest. */
  const judged = (/** @type {number} */ at, /** @type {number} */ pr, /** @type {string} */ head, /** @type {string} */ state, /** @type {any} */ over = {}, op = "pr.decided") => {
    const record = { subject: { repo: R, pr, head }, code: CODE, policy: POLICY, observedAt: at };
    const digest = digestOf(record);
    const seq = put(at, op, `pr:${pr}`, { head, state, summary: "", action: state === "PASS" ? "WAIT" : "ESCALATE", why: "", clauses: [], ...over, record: digest });
    db.prepare("INSERT INTO decision(digest,pr,head,record,first_at,last_at,first_seq,last_seq) VALUES(?,?,?,?,?,?,?,?)").run(digest, pr, head, JSON.stringify(record), at, at, seq, seq);
  };
  /** @type {any[]} */ const merged = [];
  for (let pr = 1; pr <= 10; pr++) { judged(T0 + pr * MIN + 5, pr, sha(String(pr % 10)), "PASS"); merged.push({ pr, mergedAt: T0 + pr * MIN + 30, head: sha(String(pr % 10)), mergeCommit: null }); }
  judged(T0 + 20 * MIN + 5, 21, sha("b"), "BLOCK", { action: "FIX_CI", why: "failing: unit", clauses: [{ id: "threads", state: "BLOCK" }] });
  merged.push({ pr: 21, mergedAt: T0 + 21 * MIN, head: sha("b"), mergeCommit: null });
  judged(T0 + 22 * MIN + 5, 22, sha("c"), "BLOCK", { why: "the branch conflicts with its base" });
  db.prepare("INSERT INTO review_round(nwo,pr,reviewer,source_id,outcome,head_full,head10,event_at,classifier_version) VALUES(?,?,?,?,?,?,?,?,?)")
    .run(R, 23, "codex", "review:1", "findings", sha("e"), sha("e").slice(0, 10), T0 + 23 * MIN, "v");
  db.prepare("INSERT INTO head_seen(nwo,pr,sha,first_seen_at) VALUES(?,?,?,?)").run(R, 23, sha("f"), T0 + 24 * MIN);
  judged(T0 + 1 * MIN + 10, 1, sha("e"), "PASS", {}, "queue.decided");
  merged[0].mergeCommit = sha("e");
  const seeded = [{ name: "good", why: "", must: "PASS", clauses: {}, ran: true, at: T0, got: "PASS", gotClauses: {}, ok: true, detail: "" }];
  const window = { nwo: R, since: T0, until: T0 + 80 * HOUR, merged, seeded, code: CODE, policy: POLICY };
  const before = T.trialReport(db, { repo: R, since: T0, now: window.until, merged, seeded, audits: [] });
  /** An audit of every call, each marked `right(call)`. */
  const audit = (/** @type {(c: any) => boolean} */ right, at = T0 + 81 * HOUR) => {
    const marks = new Map(before.toAudit.map((/** @type {any} */ c) => [c.id, { right: right(c), note: right(c) ? "" : "it shouldn't have" }]));
    const made = T.auditOf(before.toAudit, marks, { repo: R, by: "The Founder", at, judgment: before.judgment });
    assert.ok(made.ok, JSON.stringify(made));
    return made.audit;
  };
  return { db, window, audit };
}

test("a trial that passed at start-up still passes read again, and stops once an audit since marks a call false, or a judgment in it isn't this code's", () => {
  assert.equal(typeof T.trialHolds, "function", "src/trial.mjs has no trialHolds");
  const { db, window, audit } = passedTrial();
  const right = audit(() => true);
  /** @type {any[]} */ let audits = [right];
  const holds = () => T.trialHolds(db, { ...window, audits: () => ({ ok: true, audits }) });
  assert.deepEqual(holds(), { ok: true });
  // A person's later audit marks a call false.
  audits = [right, audit((c) => c.pr !== 21, T0 + 90 * HOUR)];
  const marked = holds();
  assert.equal(marked.ok, false);
  assert.match(marked.why, /no false call on audit/);
  // Audited right again, then a judgment in the trial found by other code.
  audits = [right];
  assert.deepEqual(holds(), { ok: true }, "control");
  db.prepare("UPDATE decision SET record = json_set(record, '$.code.commit', ?) WHERE pr = 22").run("o".repeat(40));
  const other = holds();
  assert.equal(other.ok, false);
  assert.match(other.why, /judgment\(s\) whose code or policy can't be told|made by other code/);
  // Nor where the audits can't be read.
  db.prepare("UPDATE decision SET record = json_set(record, '$.code.commit', ?) WHERE pr = 22").run(CODE.commit);
  const unread = T.trialHolds(db, { ...window, audits: () => ({ ok: false, why: "EACCES" }) });
  assert.equal(unread.ok, false);
  db.close();
});

test("enforcing, a tick whose trial no longer passes publishes in shadow from then on, and says why to a person, though it passes again", async () => {
  /** @type {boolean[][]} */ const shadows = [[], [], []];
  /** @type {number[]} */ const asked = [];
  let tick = 0;
  const r = await run({ ticks: 3, shadow: false, openPrs: () => { tick++; return [42]; }, evaluate: () => ({ ...EVAL }),
    enforcement: async () => ({ state: "enforced", why: "", fix: null, required: true }),
    trialHolds: () => { asked.push(tick + 1); return tick + 1 === 2 ? { ok: false, why: "an audit since marks #21's call false" } : { ok: true }; },
    publish: async (/** @type {any} */ a) => { shadows[tick - 1]?.push(Boolean(a.shadow)); return { ok: true, id: 1, conclusion: "neutral" }; } });
  assert.ok(shadows[0].length && shadows[1].length && shadows[2].length, `control: each tick published: ${JSON.stringify(shadows)}`);
  assert.deepEqual(shadows[0], shadows[0].map(() => false), "the first tick enforced");
  assert.deepEqual([...shadows[1], ...shadows[2]], [...shadows[1], ...shadows[2]].map(() => true), "and from the second on, shadow, though the trial passes again");
  assert.match(r.log, /NEEDS YOU: reeve went back to shadow: the shadow trial no longer passes — an audit since marks #21's call false/);
  assert.equal((r.log.match(/NEEDS YOU: reeve went back to shadow/g) ?? []).length, 1, "said once, as it stands");
  assert.match(r.esc, /reeve went back to shadow/, "and still standing after the third tick");
  assert.deepEqual(asked, [1, 2], "checked while enforcing, and not again once in shadow");
});

test("a trial that can't be checked again is taken as no longer passing", async () => {
  /** @type {boolean[]} */ const shadows = [];
  const r = await run({ ticks: 1, shadow: false, openPrs: () => [42], evaluate: () => ({ ...EVAL }),
    enforcement: async () => ({ state: "enforced", why: "", fix: null, required: true }),
    trialHolds: () => { throw new Error("database disk image is malformed"); },
    publish: async (/** @type {any} */ a) => { shadows.push(Boolean(a.shadow)); return { ok: true, id: 1, conclusion: "neutral" }; } });
  assert.ok(shadows.length && shadows.every(Boolean), JSON.stringify(shadows));
  assert.match(r.log, /reeve went back to shadow: the shadow trial no longer passes — it couldn't be checked: database disk image is malformed/);
});

test("reeve run --enforce gives the daemon the shadow trial it checked at start-up, to check again each tick", () => {
  const bin = readFileSync(join(ROOT, "bin", "reeve"), "utf8");
  const ctx = bin.slice(bin.indexOf("    const ctx = {\n      nwo, profile, db: open(dbPath),"));
  assert.match(ctx.slice(0, 20_000), /\n      trialHolds: recheck && \(\(\) => recheck\(ctx\.db\)\),/, "the run's context carries the check, on its store");
  assert.match(bin, /trialHolds\(db, \{ \.\.\.window, audits \}\)/, "the same trial, its audits read again");
});
