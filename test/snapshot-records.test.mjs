// A snapshot whose log names decision records, but that has lost their tables,
// is refused (#165). `open()` would recreate those tables empty, and every record
// the log names would be gone without a word.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateSnapshot, restore } from "../src/backup.mjs";
import { computeVerdict } from "../src/verdict.mjs";
import { run, EVAL, HEAD } from "./fixtures/tick-harness.mjs";
import { tempDir } from "./fixtures/temp.mjs";

/** What evaluatePr gives the verdict for #42: CI red at the head, everything else satisfied. */
const input = () => ({
  head: HEAD,
  checks: { verdict: "RED", settled: true, why: null, failing: [{ name: "unit", id: "1" }], inherited: [],
            impostors: [], shadowRequired: false },
  base: { verdict: "GREEN" },
  reviewers: [],
  rounds: { n: 1, softCap: 5, hardCap: 10, unspilledCritical: 0 },
  threads: { unresolved: 0, total: 0, readable: true, mergeState: "CLEAN" },
  cleared: { readable: true, uncleared: 0, reviewers: [] },
  bodyFindings: { readable: true, open: 0, reviewers: [] },
  unreadableBodies: { readable: true, open: 0, reviewers: [] },
  ledgerBlockers: 0,
  mergeState: "CLEAN",
  profile: { schemaVersion: 1, project: { kind: "product" } },
  mergeParts: null,
  hold: null,
});
const evaluate = () => { const i = input(); return { ...EVAL, verdict: computeVerdict(i), input: i }; };

/** A copy of a store one tick recorded into, with each of `drop` executed on the copy. */
async function snapshot(...drop) {
  const dir = tempDir("reeve-snap-");
  const dbPath = join(dir, "s.db");
  await run({ evaluate, dbPath });
  const snap = join(dir, "snap.db");
  copyFileSync(dbPath, snap);
  if (drop.length) { const db = new DatabaseSync(snap); for (const sql of drop) db.exec(sql); db.close(); }
  return { dir, snap };
}

test("a snapshot whose log names decision records but that lost their tables is refused", async () => {
  for (const table of ["decision", "evidence", "policy"]) {
    const { snap } = await snapshot(`DROP TABLE ${table}`);
    const v = validateSnapshot(snap, { kind: "repo" });
    assert.equal(v.ok, false, table);
    assert.match(String(v.why), new RegExp(`no ${table} table`));
  }
});

test("restore refuses it too, before replacing anything", async () => {
  const { dir, snap } = await snapshot("DROP TABLE decision");
  const r = restore(snap, join(dir, "restored.db"), { isDaemonRunning: () => false });
  assert.equal(r.ok, false);
  assert.match(String(r.why), /no decision table/);
});

test("control: a whole snapshot, and an older one whose log names no records, are still usable", async () => {
  const { snap } = await snapshot();
  assert.equal(validateSnapshot(snap, { kind: "repo" }).ok, true);
  // A store from before #165: its decisions name no record, and it has none of the tables.
  const { snap: older } = await snapshot("DROP TABLE decision", "DROP TABLE evidence", "DROP TABLE policy",
                                         "UPDATE event SET payload = json_remove(payload, '$.record') WHERE op = 'pr.decided'");
  assert.equal(validateSnapshot(older, { kind: "repo" }).ok, true);
});
