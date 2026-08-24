// The drainer, and the properties it has to hold for an effect to be trustworthy.
//
// The outbox exists so a decision and the side effect it implies are written in one
// transaction. That buys nothing unless something carries the effect out exactly
// once, survives its own crash, refuses a kind it cannot perform, and says so when
// a queue is stuck. Each of those is asserted here against the real functions.
import { open, tx, enqueue, leaseOutbox, recoverOutbox } from "../src/db/ops.mjs";
import { drainOutbox } from "../src/outbox/drain.mjs";
import { ghPrComment, markerFor, retryableFrom, HANDLERS } from "../src/outbox/effects.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};

const dir = mkdtempSync(join(tmpdir(), "reeve-drain-"));
const db = open(join(dir, "state.db"));
const put = (key, kind = "gh.pr.comment", args = { nwo: "o/r", pr: 1, body: "please review" }) =>
  tx(db, () => enqueue(db, { idemKey: key, kind, args }));
const statusOf = key => db.prepare(`SELECT status, attempts, result, last_error FROM outbox WHERE idem_key=?`).get(key);

// --- the happy path, and it is performed exactly once -------------------------
{
  put("a");
  let calls = 0;
  const handlers = { "gh.pr.comment": () => { calls++; return { ok: true, result: { commentId: 7 } }; } };
  const r = await drainOutbox({ db, handlers, max: 10 });
  check(calls === 1, "a pending effect is performed once", `called ${calls} times`);
  check(r.done.length === 1 && r.done[0].verdict === "done", "and settled done", JSON.stringify(r.done));
  check(JSON.parse(statusOf("a").result).commentId === 7, "with the handler's own result", statusOf("a").result);

  // A second drain must not perform it again. A done row is not pending.
  const again = await drainOutbox({ db, handlers, max: 10 });
  check(calls === 1, "and a second drain does not perform it again", `called ${calls} times`);
  check(again.done.length === 0, "control: because there was nothing left to lease", JSON.stringify(again.done));
}

// --- a failure retries, with the budget intact -------------------------------
{
  put("b");
  const handlers = { "gh.pr.comment": () => ({ ok: false, retryable: true, error: "HTTP 502" }) };
  await drainOutbox({ db, handlers, max: 10 });
  const row = statusOf("b");
  check(row.status === "pending", "a retryable failure returns the row to pending", JSON.stringify(row));
  check(row.attempts === 1, "having spent exactly one attempt", String(row.attempts));
  check(/502/.test(row.last_error), "and recorded why", String(row.last_error));
}

// --- a terminal failure dead-letters immediately ------------------------------
{
  put("c");
  const handlers = { "gh.pr.comment": () => ({ ok: false, retryable: false, error: "HTTP 404 Not Found" }) };
  await drainOutbox({ db, handlers, max: 10 });
  check(statusOf("c").status === "dead_letter", "a terminal failure dead-letters rather than spinning",
    JSON.stringify(statusOf("c")));
}

// --- a handler that THROWS is the handler failing, not the drainer ------------
{
  put("d");
  const handlers = { "gh.pr.comment": () => { throw new Error("boom"); } };
  const r = await drainOutbox({ db, handlers, max: 10 });
  check(Array.isArray(r.done), "a throwing handler does not take the drainer down", JSON.stringify(r).slice(0, 120));
  const row = statusOf("d");
  check(row.status === "pending" && /boom/.test(row.last_error),
    "and the throw is recorded as a retryable failure", JSON.stringify(row));
}

// --- a kind with no handler is never leased, and is REPORTED ------------------
{
  put("e", "gh.thread.resolve", { nwo: "o/r", threadId: "T_1" });
  let called = 0;
  const handlers = { "gh.pr.comment": () => { called++; return { ok: true }; } };
  const r = await drainOutbox({ db, handlers, max: 10 });
  // `attempts` is the assertion that actually reads "was it leased", because a
  // lease bumps it and nothing else does. Measured after stubbing the filter out:
  // a drainer that DOES lease an unhandled row throws inside the handler lookup,
  // catches, and returns the row to pending -- so both "the handler was not called"
  // and "the row is still pending" stay true while the property they are named for
  // is broken. Only the attempt count tells them apart.
  check(statusOf("e").attempts === 0, "an effect this build cannot perform is never leased",
    `attempts=${statusOf("e").attempts}, which means it WAS leased`);
  check(statusOf("e").status === "pending", "and is left pending rather than dead-lettered", statusOf("e").status);
  check(called === 0, "and no other kind's handler was handed it", `the comment handler ran ${called} times`);
  check(r.stranded.some(s => s.kind === "gh.thread.resolve"),
    "and the drainer says it is stranded — a stuck queue looks exactly like an idle one",
    JSON.stringify(r.stranded));
}

// --- a crashed drainer's row is recovered and completed -----------------------
{
  put("f");
  const dead = leaseOutbox(db, { worker: "dead", leaseSeconds: -5, kinds: ["gh.pr.comment"] });
  check(dead !== undefined, "control: a drainer took the row and then died", "");
  check(statusOf("f").status === "inflight", "control: leaving it inflight", statusOf("f").status);
  let calls = 0;
  const handlers = { "gh.pr.comment": () => { calls++; return { ok: true, result: { commentId: 9 } }; } };
  const r = await drainOutbox({ db, handlers, max: 10 });
  check(r.recovered >= 1, "the next drain recovers it", String(r.recovered));
  check(calls === 1 && statusOf("f").status === "done", "and completes it", `calls=${calls} ${statusOf("f").status}`);
}

// --- bounded per call, so a queue cannot starve the tick ----------------------
{
  for (let i = 0; i < 6; i++) put(`g${i}`);
  let calls = 0;
  const handlers = { "gh.pr.comment": () => { calls++; return { ok: true }; } };
  await drainOutbox({ db, handlers, max: 2 });
  check(calls === 2, "a drain performs at most `max` effects", `called ${calls} times`);
  // Counted over THIS block's rows only. Earlier blocks deliberately left retryable
  // failures pending, so a query over the whole table would be measuring them too.
  const left = db.prepare(`SELECT count(*) n FROM outbox WHERE status='pending' AND idem_key LIKE 'g%'`).get().n;
  check(left === 4, "and the rest stay pending for the next tick", String(left));
}
// --- a crash-loop dead-letters instead of retrying forever --------------------
{
  // Its OWN store. `leaseOutbox` takes the lowest-id due row, and earlier blocks
  // deliberately leave retryable failures pending -- so leases meant for this
  // fixture went to those instead and its budget never moved. The assertions then
  // measured a row nothing had happened to. A fixture that cannot reach the
  // mechanism passes for the wrong reason.
  const d2 = mkdtempSync(join(tmpdir(), "reeve-loop-"));
  const db2 = open(join(d2, "s.db"));
  const put2 = key => tx(db2, () => enqueue(db2, { idemKey: key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));
  const status2 = key => db2.prepare(`SELECT status, attempts, last_error FROM outbox WHERE idem_key=?`).get(key);
  put2("loop");
  db2.prepare(`UPDATE outbox SET max_attempts=3 WHERE idem_key='loop'`).run();
  // Three leases that never settle: a drainer dying between the API call and the
  // settle, three times. `settleOutbox` is where the budget is checked, and a hard
  // crash never reaches it -- so without a check on the recovery path this row is
  // handed out forever and `max_attempts` is never once consulted.
  for (let i = 0; i < 3; i++) {
    const j = leaseOutbox(db2, { worker: "crasher", leaseSeconds: -5, kinds: ["gh.pr.comment"] });
    check(j !== undefined, `control: lease ${i + 1} of the crashing drainer succeeded`, "");
    if (i < 2) recoverOutbox(db2);
  }
  const before = status2("loop");
  check(before.attempts === 3, "control: the row has spent its whole budget on leases", JSON.stringify(before));
  const rec = recoverOutbox(db2);
  const after = status2("loop");
  check(after.status === "dead_letter", "a row recovered past its budget is dead-lettered, not handed out again",
    JSON.stringify(after));
  check(!rec.some(r => r.id === undefined) && (rec.deadLettered ?? []).length >= 1,
    "and recovery reports it, because a crash-loop needs a person rather than another pass",
    JSON.stringify(rec.deadLettered));
  // Names the BUDGET, which is the fact, rather than a phrasing. I wrote this as a
  // prose match first and it failed on a sentence that said the same thing in
  // different words -- an hour after fixing three assertions for exactly that.
  check(/max_attempts/.test(String(after.last_error)) && String(after.last_error).length > 0,
    "with a reason naming the budget it exhausted", String(after.last_error));
  // Control: a row still inside its budget is still recovered normally.
  put2("ok-loop");
  leaseOutbox(db2, { worker: "crasher", leaseSeconds: -5, kinds: ["gh.pr.comment"] });
  recoverOutbox(db2);
  check(status2("ok-loop").status === "pending",
    "control: a row with budget left is still returned to pending", status2("ok-loop").status);
  db2.close();
  rmSync(d2, { recursive: true, force: true });
}

// --- a handler cannot outlive its lease --------------------------------------
{
  // Its own store, for the same reason as the block above: `max: 1` leases the
  // lowest-id due row, and earlier blocks leave rows pending. Three of these
  // assertions passed against a DIFFERENT row before I isolated it -- green, and
  // measuring nothing the block is named for.
  const d3 = mkdtempSync(join(tmpdir(), "reeve-slow-"));
  const db3 = open(join(d3, "s.db"));
  tx(db3, () => enqueue(db3, { idemKey: "slow", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));
  const status3 = () => db3.prepare(`SELECT status, last_error FROM outbox WHERE idem_key='slow'`).get();

  // A handler that never returns is a drainer sitting in a hung request while its
  // claim expires around it. The fence would refuse its settle afterwards -- but a
  // second drainer will already have posted, and a fence orders database writes,
  // not GitHub ones.
  const handlers = { "gh.pr.comment": () => new Promise(() => {}) };
  const t0 = Date.now();
  const r = await drainOutbox({ db: db3, handlers, max: 1, leaseSeconds: 3 });
  const took = (Date.now() - t0) / 1000;
  check(took < 3, "a hung handler is abandoned INSIDE its lease, not after it", `${took.toFixed(1)}s of a 3s lease`);
  check(r.done[0]?.verdict === "retry", "and the row is settled as a retryable failure", JSON.stringify(r.done));
  check(/did not finish within/.test(String(status3().last_error)),
    "with an error saying so rather than a silent stall", String(status3().last_error));
  check(status3().status === "pending", "so the effect is still owed, not lost", status3().status);
  db3.close();
  rmSync(d3, { recursive: true, force: true });
}

db.close();

// --- the comment handler is at-most-once across a crash ----------------------
{
  // The window the fence cannot close: the API call succeeded and the drainer died
  // before settling. Recovery re-leases the row and the retry must NOT post twice.
  const key = "review-request:o/r:1:abc:codex";
  const posted = [];
  let lists = 0, paginated = 0;
  // The comment list, as GitHub returns it: OLDEST FIRST. That ordering is the
  // reason a fixed `page=1` was wrong -- on a busy pull request the first page is
  // the page least likely to hold a comment posted seconds ago. Here the fake
  // pads the history so a single unpaginated page could not reach the marker.
  const history = Array.from({ length: 150 }, (_, i) => ({ id: i, body: `old ${i}` }));
  const api = args => {
    if (args.includes("GET")) {
      lists++;
      if (args.includes("--paginate")) paginated++;
      const all = [...history, ...posted.map((b, i) => ({ id: 1000 + i, body: b }))];
      // Unpaginated reads return only the first hundred, as the real API does.
      return { ok: true, out: JSON.stringify(args.includes("--paginate") ? all : all.slice(0, 100)) };
    }
    posted.push(args[args.indexOf("-f") + 1].replace(/^body=/, ""));
    return { ok: true, out: JSON.stringify({ id: 1000 + posted.length - 1 }) };
  };
  const args = { nwo: "o/r", pr: 1, body: "@codex review" };

  const first = ghPrComment(args, { api, idemKey: key, attempt: 1 });
  check(first.ok && posted.length === 1, "the first delivery posts the comment", JSON.stringify(first));
  check(posted[0].includes(markerFor(key)), "carrying an invisible key that identifies it", posted[0]);
  // A first attempt cannot find a previous delivery, so looking for one is a
  // paginated list call bought to answer a question already answered.
  check(lists === 0, "and a FIRST attempt does not read the comment list at all", `${lists} list call(s)`);

  const second = ghPrComment(args, { api, idemKey: key, attempt: 2 });
  check(second.ok, "a retry after a crash still reports success", JSON.stringify(second));
  check(posted.length === 1, "and does NOT post a second comment", `posted ${posted.length}`);
  check(second.result.alreadyThere === true, "because it recognised its own earlier one", JSON.stringify(second.result));
  check(paginated === 1, "having read EVERY page, not the arbitrary first one",
    `${paginated} of ${lists} list call(s) paginated`);

  // Control: a DIFFERENT key must still post. Without this the assertion above
  // passes equally well on a handler that has simply stopped posting anything.
  const other = ghPrComment(args, { api, idemKey: "review-request:o/r:1:def:codex", attempt: 2 });
  check(other.ok && posted.length === 2, "control: a different effect still posts", `posted ${posted.length}`);
}

// --- an unreadable list is not read as absence, nor as presence ---------------
{
  const posted = [];
  const api = args => args.includes("GET")
    ? { ok: false, err: "HTTP 502" }
    : (posted.push("x"), { ok: true, out: JSON.stringify({ id: 1 }) });
  const r = ghPrComment({ nwo: "o/r", pr: 1, body: "b" }, { api, idemKey: "k", attempt: 2 });
  check(r.ok && posted.length === 1, "a failed pre-check falls through and posts, rather than assuming delivered",
    JSON.stringify(r));
}

// --- which GitHub failures are worth retrying --------------------------------
{
  for (const [err, want] of [["HTTP 404 Not Found", false], ["HTTP 403 Resource not accessible", false],
                             ["HTTP 422 Unprocessable", false], ["HTTP 502 Bad Gateway", true],
                             ["socket hang up", true], ["", true]])
    check(retryableFrom(err) === want, `"${err || "(empty)"}" is ${want ? "retryable" : "terminal"}`, "");
}

// --- the shipped handler table is what the drainer would actually use ---------
{
  check(typeof HANDLERS["gh.pr.comment"] === "function", "the build ships a gh.pr.comment handler", "");
  check(Object.isFrozen(HANDLERS), "and the table cannot be widened at runtime", "");
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
