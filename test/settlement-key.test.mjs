// A check set's settlement key, kept in the store between readings (#298's
// review). Some Node releases' SQLite binding returns stored text only up to its
// first NUL, and the key joined check names with one: it never matched itself
// on the next reading, so no set of more than one check ever settled.
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { open, loadSettlement, saveSettlement } from "../src/db/ops.mjs";
import { settle } from "../src/github/reconciler.mjs";
import { tempDir } from "./fixtures/temp.mjs";

const SHA = "5".repeat(40);
const passed = (/** @type {string} */ name) => ({ name, conclusion: "success", status: "completed" });
const green = { verdict: "GREEN", sha: SHA, rows: [passed("b"), passed("a")], why: "2 check(s) all passing" };

test("a settlement key holds no NUL, where some SQLite bindings cut stored text", () => {
  const next = settle(null, green);
  assert.equal(next.key.includes("\0"), false, JSON.stringify(next.key));
});

test("three green readings of several checks settle across the store, and its names read back", () => {
  const db = open(join(tempDir("reeve-settle-key-"), "s.db"));
  let s = settle(null, green);
  for (let i = 0; i < 3; i++) { s = settle(loadSettlement(db, "o/r", 1), green); saveSettlement(db, "o/r", 1, s, 1_900_000_000 + i); }
  const back = loadSettlement(db, "o/r", 1);
  db.close();
  assert.equal(s.settled, true, s.why);
  assert.deepEqual(back?.names, ["a", "b"]);
});
