// The outbox's fence, and the race it exists for.
//
// `settleOutbox` used to match on `id` alone. That is enough right up until a
// drainer stalls: A's lease expires, recovery returns the row to pending, B leases
// it and begins delivering — and A, still running, settles B's live delivery. The
// GitHub effect goes out twice and the row records the wrong outcome, with nothing
// in the store to say it happened.
//
// A TTL plus a liveness check is not a substitute. `isAlive` answers "is anyone
// there", never "is this still yours", and a paused process keeps its pid — so it
// says yes for exactly the process that has to be refused.
import { open, tx, enqueue, leaseOutbox, settleOutbox, recoverOutbox } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-fence-"));
const dbPath = join(dir, "state.db");
const db = open(dbPath);
const put = key => tx(db, () => enqueue(db, { idemKey: key, kind: "gh.pr.comment", args: { body: key } }));

// --- the fence moves, and it moves separately from the budget -----------------
{
  put("a");
  const first = leaseOutbox(db, { worker: "d1" });
  check(Number.isInteger(first?.lease_token), "a lease returns a fence token", JSON.stringify(first?.lease_token));
  check(first.lease_token === 1, "which starts at 1 for a row that has never been leased", String(first.lease_token));

  settleOutbox(db, { id: first.id, leaseToken: first.lease_token, ok: false, error: "429", retryable: true });
  db.prepare(`UPDATE outbox SET not_before=0 WHERE id=?`).run(first.id);   // skip the backoff
  const second = leaseOutbox(db, { worker: "d2" });
  check(second?.id === first.id, "control: the same row is leased again", JSON.stringify(second?.id));
  check(second.lease_token === 2, "and the fence has moved", String(second.lease_token));
  settleOutbox(db, { id: second.id, leaseToken: second.lease_token, ok: true, result: {} });
}

// --- the race itself ----------------------------------------------------------
{
  put("b");
  // A takes the row with a lease that is ALREADY expired: the crash, without
  // waiting for one.
  const A = leaseOutbox(db, { worker: "A", leaseSeconds: -5 });
  check(A !== undefined, "control: A holds the row", "");
  const recovered = recoverOutbox(db);
  check(recovered.some(r => r.id === A.id), "control: recovery returns A's expired row to pending",
    JSON.stringify(recovered));

  const B = leaseOutbox(db, { worker: "B" });
  check(B?.id === A.id, "control: B now holds the same row", `${B?.id} vs ${A.id}`);
  check(B.lease_token !== A.lease_token, "control: and holds a different fence", `${B.lease_token} vs ${A.lease_token}`);

  // A wakes up and settles the delivery it no longer owns. THIS is the defect.
  const verdict = settleOutbox(db, { id: A.id, leaseToken: A.lease_token, ok: true, result: { commentId: 111 } });
  check(verdict === "stale", "a stale holder's settle is refused", String(verdict));

  const row = db.prepare(`SELECT status, result, lease_token FROM outbox WHERE id=?`).get(A.id);
  check(row.status === "inflight", "and the row is untouched — still B's, still in flight", JSON.stringify(row));
  check(row.result === null, "and B's delivery was not overwritten with A's result", String(row.result));

  // B settles for real, and that one lands.
  const good = settleOutbox(db, { id: B.id, leaseToken: B.lease_token, ok: true, result: { commentId: 222 } });
  check(good === "done", "control: the real holder still settles normally", String(good));
  const after = db.prepare(`SELECT status, result FROM outbox WHERE id=?`).get(B.id);
  check(JSON.parse(after.result).commentId === 222, "with its own result, not the stale one", after.result);
}

// --- a stale FAILURE cannot spend the budget or dead-letter the row ------------
{
  put("c");
  const A = leaseOutbox(db, { worker: "A", leaseSeconds: -5 });
  recoverOutbox(db);
  const B = leaseOutbox(db, { worker: "B" });
  const before = db.prepare(`SELECT attempts, status FROM outbox WHERE id=?`).get(B.id);
  const verdict = settleOutbox(db, { id: A.id, leaseToken: A.lease_token, ok: false,
                                     error: "A's error", retryable: false });
  check(verdict === "stale", "a stale holder cannot dead-letter the row either", String(verdict));
  const after = db.prepare(`SELECT attempts, status, last_error FROM outbox WHERE id=?`).get(B.id);
  check(after.status === before.status && after.attempts === before.attempts,
    "and neither the status nor the retry budget moved", `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  check(after.last_error === null, "and the loser's error was not recorded as the row's", String(after.last_error));
}

// --- an unfenced settle is impossible to reach by omission --------------------
{
  put("d");
  const j = leaseOutbox(db, { worker: "d1" });
  let threw = null;
  try { settleOutbox(db, { id: j.id, ok: true, result: {} }); } catch (e) { threw = e.message; }
  check(threw !== null && /leaseToken/.test(threw), "settling without a fence throws rather than settling",
    String(threw));
  const row = db.prepare(`SELECT status FROM outbox WHERE id=?`).get(j.id);
  check(row.status === "inflight", "control: and the throw left the row alone", row.status);
}

// --- the event log says a race happened --------------------------------------
{
  const stale = db.prepare(`SELECT count(*) n FROM event WHERE op='outbox.stale'`).get().n;
  check(stale >= 2, "every refused settle is recorded, so a race is visible afterwards", String(stale));
}
db.close();

// --- it lands on a database that already has rows in it -----------------------
{
  // The migration half. A defaulted integer column is what `ADDED_COLUMNS` is for,
  // but "it should work" is not a measurement: this builds a store WITHOUT the
  // column, puts a row in it, and reopens.
  const dir2 = mkdtempSync(join(tmpdir(), "reeve-fence-mig-"));
  const p2 = join(dir2, "state.db");
  const a = open(p2);
  tx(a, () => enqueue(a, { idemKey: "old", kind: "notify", args: { x: 1 } }));
  a.prepare(`ALTER TABLE outbox DROP COLUMN lease_token`).run();          // back to the old shape
  const cols = a.prepare(`PRAGMA table_info(outbox)`).all().map(c => c.name);
  check(!cols.includes("lease_token"), "control: the store really is on the pre-fence shape", cols.join(","));
  check(a.prepare(`SELECT count(*) n FROM outbox`).get().n === 1, "control: and it holds a real row", "");
  a.close();

  const b = open(p2);                                                     // the upgrade path
  const cols2 = b.prepare(`PRAGMA table_info(outbox)`).all().map(c => c.name);
  check(cols2.includes("lease_token"), "reopening a populated store adds the fence", cols2.join(","));
  check(b.prepare(`SELECT lease_token FROM outbox WHERE idem_key='old'`).get().lease_token === 0,
    "and the row that was already there starts unfenced at 0", "");
  const j = leaseOutbox(b, { worker: "d1" });
  check(j?.lease_token === 1, "and the first lease of that old row fences it", String(j?.lease_token));
  b.close();
  rmSync(dir2, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
