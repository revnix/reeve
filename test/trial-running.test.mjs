// The shadow trial's running time (#297). The daemon recorded a tick only as it
// ended, so a tick that took longer than the trial's gap, over more open pull
// requests say, read as the daemon being down. Each tick's start is recorded
// too, and the time inside a tick is running, as long as a tick may take.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { open } from "../src/db/ops.mjs";
import { trialReport } from "../src/trial.mjs";
import { tempDir } from "./fixtures/temp.mjs";
import { run } from "./fixtures/tick-harness.mjs";

const T0 = 1_900_000_000, MIN = 60, HOUR = 3600, R = "o/r";

/** A store, and the daemon's ticks put in it: each started at `start` and ended at `end`, either left out as null. */
function store() {
  const path = join(tempDir("reeve-trial-running-"), "s.db");
  const db = open(path);
  const put = (/** @type {number} */ at, /** @type {string} */ op) =>
    db.prepare("INSERT INTO event(at,actor,op,subject,payload) VALUES(?,?,?,?,?)").run(at, "daemon", op, null, "{}");
  const tick = (/** @type {number | null} */ start, /** @type {number | null} */ end) => {
    if (start !== null) put(start, "daemon.tick.started");
    if (end !== null) put(end, "daemon.tick");
  };
  return { db, path, tick };
}
/** The report from `since` to `now`, merging nothing. */
const report = (/** @type {any} */ db, /** @type {number} */ since, /** @type {number} */ now) => trialReport(db, { repo: R, since, now, merged: [] });
/** Five-minute ticks, five minutes apart, from `from` to `to`. */
const ticking = (/** @type {ReturnType<typeof store>} */ s, /** @type {number} */ from, /** @type {number} */ to) => {
  for (let t = from; t + 5 * MIN <= to; t += 10 * MIN) s.tick(t, t + 5 * MIN);
};

test("a tick that took longer than the gap, its start and end recorded, is running, not downtime", () => {
  const s = store();
  ticking(s, T0, T0 + HOUR);
  // Forty minutes, over many open pull requests, then the usual five-minute sleep.
  s.tick(T0 + HOUR, T0 + HOUR + 40 * MIN);
  ticking(s, T0 + HOUR + 45 * MIN, T0 + 2 * HOUR + 45 * MIN);
  const r = report(s.db, T0, T0 + 2 * HOUR + 45 * MIN);
  s.db.close();
  assert.deepEqual(r.running.down, []);
  assert.ok(Math.abs(r.running.hours - 2.75) < 0.01, `${r.running.hours}`);
});

test("a gap of over 15 minutes between one tick's end and the next's start is downtime", () => {
  const s = store();
  ticking(s, T0, T0 + HOUR);
  ticking(s, T0 + HOUR + 20 * MIN, T0 + 2 * HOUR);
  const r = report(s.db, T0, T0 + 2 * HOUR);
  s.db.close();
  assert.deepEqual(r.running.down, [{ from: T0 + 55 * MIN, to: T0 + HOUR + 20 * MIN }]);
});

test("a tick still running when the report is made is running", () => {
  const s = store();
  ticking(s, T0, T0 + HOUR);
  s.tick(T0 + HOUR, null);
  const r = report(s.db, T0, T0 + HOUR + 30 * MIN);
  s.db.close();
  assert.deepEqual(r.running.down, []);
});

test("a tick that started before the report's start and ended after it is running from the start", () => {
  const s = store();
  s.tick(T0 - 10 * MIN, T0 + 30 * MIN);
  ticking(s, T0 + 35 * MIN, T0 + HOUR + 35 * MIN);
  const r = report(s.db, T0, T0 + HOUR + 35 * MIN);
  s.db.close();
  assert.deepEqual(r.running.down, []);
});

test("a tick of over an hour is downtime: a daemon stopped partway doesn't pass for one running", () => {
  const s = store();
  ticking(s, T0, T0 + HOUR);
  s.tick(T0 + HOUR, T0 + 2 * HOUR + 30 * MIN);
  const r = report(s.db, T0, T0 + 2 * HOUR + 30 * MIN);
  s.db.close();
  assert.deepEqual(r.running.down, [{ from: T0 + HOUR, to: T0 + 2 * HOUR + 30 * MIN }]);
});

test("a tick that started and never ended, the next starting later, isn't running in between", () => {
  const s = store();
  ticking(s, T0, T0 + HOUR);
  // Stopped partway, and started again forty minutes on.
  s.tick(T0 + HOUR, null);
  ticking(s, T0 + HOUR + 40 * MIN, T0 + 2 * HOUR + 40 * MIN);
  const r = report(s.db, T0, T0 + 2 * HOUR + 40 * MIN);
  s.db.close();
  assert.deepEqual(r.running.down, [{ from: T0 + HOUR, to: T0 + HOUR + 40 * MIN }]);
});

test("a store that recorded only the ends of ticks reads as before", () => {
  const s = store();
  for (let t = T0 + 10 * MIN; t <= T0 + HOUR; t += 10 * MIN) s.tick(null, t);
  for (let t = T0 + 2 * HOUR; t <= T0 + 3 * HOUR; t += 10 * MIN) s.tick(null, t);
  const r = report(s.db, T0, T0 + 3 * HOUR);
  s.db.close();
  assert.deepEqual(r.running.down, [{ from: T0 + HOUR, to: T0 + 2 * HOUR }]);
});

test("the daemon records each tick's start, before its end", async () => {
  const path = join(tempDir("reeve-trial-running-tick-"), "s.db");
  open(path).close();
  await run({ dbPath: path, ticks: 2, openPrs: () => [], prState: () => "OPEN", prIsFinished: () => false });
  const db = open(path);
  const ops = db.prepare("SELECT op FROM event WHERE op IN ('daemon.tick', 'daemon.tick.started') ORDER BY seq").all().map((/** @type {any} */ e) => e.op);
  db.close();
  assert.deepEqual(ops, ["daemon.tick.started", "daemon.tick", "daemon.tick.started", "daemon.tick"]);
});

// ── #301's first review ──────────────────────────────────────────────────────

test("a tick that halted, and the next started five minutes on, isn't running in between", () => {
  const s = store();
  ticking(s, T0, T0 + HOUR);
  // Halted before its end, as a tick that couldn't list the pull requests does, and tried again.
  s.tick(T0 + HOUR, null);
  s.tick(T0 + HOUR + 5 * MIN, T0 + HOUR + 10 * MIN);
  ticking(s, T0 + HOUR + 15 * MIN, T0 + 2 * HOUR);
  const r = report(s.db, T0, T0 + 2 * HOUR);
  s.db.close();
  assert.deepEqual(r.running.down, [{ from: T0 + HOUR, to: T0 + HOUR + 5 * MIN }]);
});

test("a daemon whose every tick halts runs no time, however often it tries", () => {
  const s = store();
  for (let t = T0; t < T0 + 2 * HOUR; t += 5 * MIN) s.tick(t, null);
  const r = report(s.db, T0, T0 + 2 * HOUR);
  s.db.close();
  assert.ok(r.running.hours < 0.2, `${r.running.hours} hours`);
});

test("a tick under way for over an hour as the report starts is downtime, though it ends soon after", () => {
  const s = store();
  s.tick(T0 - 70 * MIN, T0 + 10 * MIN);
  ticking(s, T0 + 15 * MIN, T0 + HOUR);
  const r = report(s.db, T0, T0 + HOUR);
  s.db.close();
  assert.deepEqual(r.running.down, [{ from: T0, to: T0 + 10 * MIN }]);
});

// ── #301's second review ─────────────────────────────────────────────────────

test("a report that falls inside one tick still running is running throughout", () => {
  const s = store();
  s.tick(T0 - 5 * MIN, null);
  const r = report(s.db, T0, T0 + 10 * MIN);
  s.db.close();
  assert.deepEqual(r.running.down, []);
  assert.ok(Math.abs(r.running.hours - 10 / 60) < 0.001, `${r.running.hours} hours`);
});
