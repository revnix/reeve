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
db.close();

// --- the comment handler is at-most-once across a crash ----------------------
{
  // The window the fence cannot close: the API call succeeded and the drainer died
  // before settling. Recovery re-leases the row and the retry must NOT post twice.
  const key = "review-request:o/r:1:abc:codex";
  const posted = [];
  const api = args => {
    if (args[0] === "-X" && args[1] === "GET")
      return { ok: true, out: JSON.stringify(posted.map((b, i) => ({ id: 100 + i, body: b }))) };
    posted.push(args[args.indexOf("-f") + 1].replace(/^body=/, ""));
    return { ok: true, out: JSON.stringify({ id: 100 + posted.length - 1 }) };
  };
  const args = { nwo: "o/r", pr: 1, body: "@codex review" };
  const first = ghPrComment(args, { api, idemKey: key });
  check(first.ok && posted.length === 1, "the first delivery posts the comment", JSON.stringify(first));
  check(posted[0].includes(markerFor(key)), "carrying an invisible key that identifies it", posted[0]);

  const second = ghPrComment(args, { api, idemKey: key });
  check(second.ok, "a retry after a crash still reports success", JSON.stringify(second));
  check(posted.length === 1, "and does NOT post a second comment", `posted ${posted.length}`);
  check(second.result.alreadyThere === true, "because it recognised its own earlier one", JSON.stringify(second.result));

  // Control: a DIFFERENT key must still post. Without this the assertion above
  // passes equally well on a handler that has simply stopped posting anything.
  const other = ghPrComment(args, { api, idemKey: "review-request:o/r:1:def:codex" });
  check(other.ok && posted.length === 2, "control: a different effect still posts", `posted ${posted.length}`);
}

// --- an unreadable list is not read as absence, nor as presence ---------------
{
  const posted = [];
  const api = args => (args[1] === "GET")
    ? { ok: false, err: "HTTP 502" }
    : (posted.push("x"), { ok: true, out: JSON.stringify({ id: 1 }) });
  const r = ghPrComment({ nwo: "o/r", pr: 1, body: "b" }, { api, idemKey: "k" });
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
