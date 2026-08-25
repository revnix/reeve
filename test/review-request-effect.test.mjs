// REQUEST_REVIEW stops being a worker task.
//
// It posts each reviewer's trigger comment verbatim. No judgement, no reading of
// the diff, nothing a model is needed for -- it was a paid dispatch only because
// reeve could not act on GitHub itself, and the worker's own `gh` was then refused
// when it tried. Now reeve enqueues the comment and the drainer posts it.
//
// Two things have to hold: the gate is OFF unless a profile says otherwise, and a
// repeated tick at one head must not ask twice while a NEW head must ask again.
import { reviewActionsOn } from "../src/daemon.mjs";
import { open, tx, enqueue, supersedeEffects } from "../src/db/ops.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

// --- the gate is off unless a profile says otherwise --------------------------
{
  check(reviewActionsOn({}) === false, "a profile that says nothing leaves review actions OFF", "");
  check(reviewActionsOn({ watch: {} }) === false, "and so does an empty watch block", "");
  check(reviewActionsOn(undefined) === false, "and so does no profile at all", "");
  check(reviewActionsOn(null) === false, "and null", "");
  // Not truthy -- exactly true. A string "false" from a hand-edited profile is the
  // shape that turns a safety flag on by accident.
  for (const v of ["true", "false", 1, {}, []])
    check(reviewActionsOn({ watch: { reviewActions: v } }) === false,
      `a ${JSON.stringify(v)} does not arm it — only the boolean does`, "");
  check(reviewActionsOn({ watch: { reviewActions: true } }) === true,
    "control: the boolean true does arm it", "");
}

// --- asking twice at one head is one ask; a new head is a new one -------------
{
  const dir = mkdtempSync(join(tmpdir(), "reeve-rr-"));
  const db = open(join(dir, "state.db"));
  // The key the daemon builds, reproduced here so the property is asserted rather
  // than the daemon's private string.
  const keyFor = (pr, head, login) => `review-request:o/r:${pr}:${head}:${login}`;
  const ask = (pr, head, login) => tx(db, () => enqueue(db, {
    idemKey: keyFor(pr, head, login), kind: "gh.pr.comment",
    args: { nwo: "o/r", pr, body: `@${login} review` },
  }));

  const first = ask(1, "aaa", "codex");
  check(first !== null, "the first ask at a head enqueues", String(first));
  const repeat = ask(1, "aaa", "codex");
  check(repeat === null, "a repeated tick at the SAME head enqueues nothing", String(repeat));
  const moved = ask(1, "bbb", "codex");
  check(moved !== null, "a NEW head is a new round and asks again", String(moved));
  const other = ask(1, "aaa", "coderabbit");
  check(other !== null, "and a second reviewer at the same head is its own effect", String(other));

  const rows = db.prepare(`SELECT count(*) n FROM outbox WHERE kind='gh.pr.comment'`).get().n;
  check(rows === 3, "so three effects exist, not four and not one", String(rows));
  // The enqueue must be a real row with the body in it, or the dedup above is
  // measuring an empty table.
  const one = db.prepare(`SELECT args FROM outbox WHERE idem_key=?`).get(keyFor(1, "aaa", "codex"));
  check(JSON.parse(one.args).body === "@codex review", "control: carrying the trigger verbatim", one.args);

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- a new head withdraws the request the old head left pending ---------------
{
  // The sequence: delivery fails transiently, the row waits on a backoff, and the
  // pull request gets a new commit before the retry comes due. The new head
  // enqueues under a different key, so both are pending -- and they carry
  // different markers, so neither idempotency check can see the other. The
  // reviewer is then asked twice for what is now the same head.
  const dir = mkdtempSync(join(tmpdir(), "reeve-sup-"));
  const db = open(join(dir, "state.db"));
  const key = (head, login) => `review-request:o/r:7:${head}:${login}`;
  const put = (head, login) => tx(db, () => enqueue(db, {
    idemKey: key(head, login), kind: "gh.pr.comment", args: { nwo: "o/r", pr: 7, body: `@${login} review` },
  }));
  const statusOf = k => db.prepare(`SELECT status FROM outbox WHERE idem_key=?`).get(k)?.status ?? null;

  put("old", "codex");
  put("old", "coderabbit");
  // A different pull request, to prove the prefix does not reach past its own.
  tx(db, () => enqueue(db, { idemKey: "review-request:o/r:8:old:codex", kind: "gh.pr.comment", args: {} }));
  check(statusOf(key("old", "codex")) === "pending", "control: the old head's request is pending", "");

  const dropped = tx(db, () => {
    const n = supersedeEffects(db, { prefix: "review-request:o/r:7:", keep: key("new", "codex") });
    enqueue(db, { idemKey: key("new", "codex"), kind: "gh.pr.comment", args: { nwo: "o/r", pr: 7, body: "@codex review" } });
    return n;
  });
  check(dropped === 2, "a new head withdraws every pending request for that pull request", String(dropped));
  check(statusOf(key("old", "codex")) === null, "so the superseded row is gone, not left to fire later", "");
  check(statusOf(key("new", "codex")) === "pending", "and the new one stands", String(statusOf(key("new", "codex"))));
  check(statusOf("review-request:o/r:8:old:codex") === "pending",
    "and ANOTHER pull request's request is untouched", String(statusOf("review-request:o/r:8:old:codex")));

  // An INFLIGHT row is not withdrawn: a drainer may be mid-delivery, and deleting
  // a row it holds would leave it settling into nothing.
  put("live", "codex");
  db.prepare(`UPDATE outbox SET status='inflight' WHERE idem_key=?`).run(key("live", "codex"));
  const n2 = tx(db, () => supersedeEffects(db, { prefix: "review-request:o/r:7:", keep: key("newer", "codex") }));
  check(statusOf(key("live", "codex")) === "inflight", "an inflight request is left alone, not deleted under its drainer",
    String(statusOf(key("live", "codex"))));
  check(n2 >= 1, "control: but the pending one beside it was still withdrawn", String(n2));

  // The withdrawal is on the record. A row that vanishes with no event is a
  // review request that disappeared for reasons nobody can reconstruct.
  const ev = db.prepare(`SELECT count(*) n FROM event WHERE op='outbox.superseded'`).get().n;
  check(ev >= 3, "every withdrawal is emitted", String(ev));

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
