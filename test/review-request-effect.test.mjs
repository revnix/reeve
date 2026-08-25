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
import { open, tx, enqueue, supersedeEffects, sha256 } from "../src/db/ops.mjs";
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

// --- every reviewer is summoned, not only the last ----------------------------
{
  // The key had the head before the login, so no prefix could name one reviewer's
  // requests and `supersedes` matched every reviewer on the pull request. The
  // effects are enqueued in a loop, so the second reviewer's supersede deleted the
  // first reviewer's row that had just been created -- and only the last reviewer
  // was ever summoned. Two reviewers is the smallest fixture that can show it;
  // with one, the bug is invisible.
  const dir = mkdtempSync(join(tmpdir(), "reeve-multi-"));
  const db = open(join(dir, "state.db"));
  const effects = [
    { login: "codex", key: "review-request:o/r:9:codex:HEAD1" },
    { login: "coderabbit", key: "review-request:o/r:9:coderabbit:HEAD1" },
  ];
  tx(db, () => {
    for (const e of effects) {
      supersedeEffects(db, { prefix: `review-request:o/r:9:${e.login}:`, keep: e.key });
      enqueue(db, { idemKey: e.key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 9, body: `@${e.login} review` } });
    }
  });
  const pending = db.prepare(`SELECT idem_key FROM outbox WHERE status='pending' ORDER BY idem_key`).all().map(r => r.idem_key);
  check(pending.length === 2, "both reviewers' requests survive being enqueued together", JSON.stringify(pending));
  for (const e of effects)
    check(pending.includes(e.key), `${e.login} is still queued after the others were processed`, JSON.stringify(pending));

  // And a new head still supersedes each reviewer's own earlier request, without
  // touching the other's. Without this the assertion above passes on a supersede
  // that has simply stopped working.
  tx(db, () => {
    supersedeEffects(db, { prefix: "review-request:o/r:9:codex:", keep: "review-request:o/r:9:codex:HEAD2" });
    enqueue(db, { idemKey: "review-request:o/r:9:codex:HEAD2", kind: "gh.pr.comment", args: {} });
  });
  const after = db.prepare(`SELECT idem_key FROM outbox WHERE status='pending' ORDER BY idem_key`).all().map(r => r.idem_key);
  check(!after.includes("review-request:o/r:9:codex:HEAD1"), "control: a new head does supersede that reviewer's old request", JSON.stringify(after));
  check(after.includes("review-request:o/r:9:coderabbit:HEAD1"), "and leaves the OTHER reviewer's request alone", JSON.stringify(after));

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

// --- correcting a trigger at the same head is a new request -------------------
{
  // An operator fixes a trigger the bot accepted syntactically and then ignored.
  // Without the trigger's CONTENT in the identity the key is unchanged, so the
  // existing done or dead-lettered row wins the conflict, the corrected body is
  // never enqueued, and that reviewer cannot be summoned at all until some other
  // commit happens to move the head -- an unrelated event that may never come.
  //
  // The key is built here the way the daemon builds it, so the property is
  // asserted rather than the daemon's private string.
  const dir = mkdtempSync(join(tmpdir(), "reeve-trig-"));
  const db = open(join(dir, "state.db"));
  const keyFor = trigger => `review-request:o/r:9:codex:head1:${sha256(trigger).slice(0, 12)}`;
  const ask = trigger => tx(db, () => enqueue(db, {
    idemKey: keyFor(trigger), kind: "gh.pr.comment", args: { nwo: "o/r", pr: 9, body: trigger },
  }));

  const wrong = ask("@codex plz review");
  check(wrong !== null, "control: the first trigger enqueues", String(wrong));
  const again = ask("@codex plz review");
  check(again === null, "control: and asking with the SAME trigger enqueues nothing", String(again));

  const fixed = ask("@codex review");
  check(fixed !== null, "a corrected trigger at the same head is a NEW request", String(fixed));
  check(keyFor("@codex plz review") !== keyFor("@codex review"),
    "because the trigger's content is part of the identity", "");
  const bodies = db.prepare(`SELECT args FROM outbox`).all().map(r => JSON.parse(r.args).body).sort();
  check(bodies.length === 2 && bodies.includes("@codex review"),
    "and the corrected body is actually queued, not swallowed by the conflict", JSON.stringify(bodies));

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

  // --- a DEAD LETTER for an overtaken head is retired too ---------------------
  //
  // A dead letter is permanent and is counted into a standing escalation every
  // tick. So an old head's request that failed terminally goes on demanding a
  // person's attention after the reviewer has been successfully summoned for the
  // current head -- naming work that must no longer be performed. It is not merely
  // late; it is obsolete.
  put("dead", "codex");
  db.prepare(`UPDATE outbox SET status='dead_letter' WHERE idem_key=?`).run(key("dead", "codex"));
  check(statusOf(key("dead", "codex")) === "dead_letter", "control: a terminal row from an old head", "");
  const n3 = tx(db, () => supersedeEffects(db, { prefix: "review-request:o/r:7:", keep: key("newest", "codex") }));
  check(statusOf(key("dead", "codex")) === null,
    "a dead letter for an overtaken head is retired, not left nagging forever", String(n3));
  // Control: an INFLIGHT row is still spared, so the widening did not simply
  // start deleting everything that matched the prefix.
  check(statusOf(key("live", "codex")) === "inflight",
    "control: and an inflight row is still spared", String(statusOf(key("live", "codex"))));

  // The withdrawal is on the record. A row that vanishes with no event is a
  // review request that disappeared for reasons nobody can reconstruct.
  const ev = db.prepare(`SELECT count(*) n FROM event WHERE op='outbox.superseded'`).get().n;
  check(ev >= 3, "every withdrawal is emitted", String(ev));

  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
