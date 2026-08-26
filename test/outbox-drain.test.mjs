// The drainer, and the properties it has to hold for an effect to be trustworthy.
//
// The outbox exists so a decision and the side effect it implies are written in one
// transaction. That buys nothing unless something carries the effect out exactly
// once, survives its own crash, refuses a kind it cannot perform, and says so when
// a queue is stuck. Each of those is asserted here against the real functions.
import { open, tx, enqueue, leaseOutbox, recoverOutbox, supersedeEffects } from "../src/db/ops.mjs";
import { drainOutbox } from "../src/outbox/drain.mjs";
import { ghPrComment, markerFor, retryableFrom, HANDLERS } from "../src/outbox/effects.mjs";
import { apiAsInstallation } from "../src/github/app.mjs";
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

// --- ENOBUFS and a timeout are told apart ------------------------------------
{
  // Measured on node v24.17.0, both failures set `signal === "SIGTERM"` and leave
  // `killed` undefined:
  //
  //   maxBuffer overflow -> code=ENOBUFS   signal=SIGTERM  killed=undefined
  //   timeout            -> code=ETIMEDOUT signal=SIGTERM  killed=undefined
  //
  // So the signal cannot separate them, and a `killed` test never fires at all.
  // They have to be told apart because a caller acts on them differently: a
  // timeout is transient and worth retrying, while an overflow means the request
  // SUCCEEDED and the answer did not fit -- and this handler reads a failed read
  // as "no marker found" and posts the duplicate it exists to prevent.
  const big = apiAsInstallation("t", ["--version"], { maxBuffer: 4 });
  check(big.ok === false, "control: a four-byte buffer really does fail", JSON.stringify(big));
  check(big.truncated === true && !big.timedOut,
    "an output that did not fit is reported as truncation, not as a timeout", JSON.stringify(big));

  const slow = apiAsInstallation("t", ["--version"], { timeoutMs: 1 });
  check(slow.ok === false, "control: a one-millisecond timeout really does fail", JSON.stringify(slow));
  check(slow.timedOut === true && !slow.truncated,
    "and a timeout is reported as a timeout", JSON.stringify(slow));
}

// --- an effect cannot be enqueued outside a transaction ----------------------
{
  // The invariant the table exists for, and it used to be a comment: "must be
  // called inside the same tx as the state change that decided it". A rule that
  // lives in every caller lives in none of them, and a bare `enqueue(db, …)` is an
  // ordinary-looking line that produces exactly the failure the outbox prevents.
  let threw = null;
  try { enqueue(db, { idemKey: "bare", kind: "gh.pr.comment", args: {} }); }
  catch (e) { threw = e.message; }
  check(threw !== null && /transaction/i.test(threw),
    "enqueuing outside a transaction throws rather than succeeding", String(threw));
  check(db.prepare(`SELECT count(*) n FROM outbox WHERE idem_key='bare'`).get().n === 0,
    "and nothing is written", "");
  // Control: the same call INSIDE one works, or the assertion above would pass on
  // an enqueue that had simply stopped functioning.
  const id = tx(db, () => enqueue(db, { idemKey: "wrapped", kind: "gh.pr.comment", args: {} }));
  check(id !== null && id !== undefined, "control: inside a transaction it enqueues normally", String(id));
  db.prepare(`DELETE FROM outbox WHERE idem_key='wrapped'`).run();

  // And reconciliation demands one for a stronger reason than enqueue does: it
  // performs several deletes and an event insert per delete, and those describe
  // ONE reconciliation. A crash partway leaves some obsolete effects removed
  // without their audit events while others stay queued, and a reader cannot then
  // tell a partial reconciliation from a complete one. It must also commit WITH
  // the decision that produced it, or a crash between the two leaves the queue
  // reconciled against a decision that was never recorded.
  let threw2 = null;
  try { supersedeEffects(db, { prefix: "x:", keep: new Set() }); } catch (e) { threw2 = e.message; }
  check(threw2 !== null && /transaction/i.test(threw2),
    "reconciling outside a transaction throws rather than half-applying", String(threw2));
  const inTx = tx(db, () => supersedeEffects(db, { prefix: "x:", keep: new Set() }));
  check(inTx === 0, "control: inside one it runs normally", String(inTx));
}

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

  // ONE more pass first, and it is not generosity. The final allowed lease can
  // POST the comment and crash before settling: at that point attempts equals the
  // budget, and dead-lettering records a delivered effect as one reeve "could not
  // perform" -- and escalates it -- while GitHub already contains it. The handler's
  // marker pre-check is the only thing that can tell those apart, and it needs a
  // lease to run.
  const recon = recoverOutbox(db2);
  check(status2("loop").status === "pending",
    "a row at its budget gets ONE reconciliation pass before terminal failure", JSON.stringify(status2("loop")));
  check((recon.deadLettered ?? []).length === 0, "and is not dead-lettered yet", JSON.stringify(recon.deadLettered));

  // That pass is spent, and now it terminates.
  const j4 = leaseOutbox(db2, { worker: "crasher", leaseSeconds: -5, kinds: ["gh.pr.comment"] });
  check(j4 !== undefined && status2("loop").attempts === 4,
    "control: the reconciliation lease happened and went past the budget", JSON.stringify(status2("loop")));
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

// --- one budget for the whole pass, not one per effect ------------------------
{
  // `max` bounds how many effects a pass performs. It does not bound how LONG the
  // pass takes, and those are different guarantees: ten deliveries each given a
  // fresh deadline can spend the sum of ten deadlines. This runs inside a tick
  // that also evaluates pull requests, publishes verdicts and raises alerts, so an
  // outbox in trouble would stop the guardian doing everything else it exists for.
  const d4 = mkdtempSync(join(tmpdir(), "reeve-budget-"));
  const db4 = open(join(d4, "s.db"));
  for (let i = 0; i < 6; i++)
    tx(db4, () => enqueue(db4, { idemKey: `b${i}`, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));

  // A fake clock, so the assertion is about the budget rather than about how fast
  // this machine happens to be. Each delivery "takes" 400ms of it.
  let clock = 0;
  const handlers = { "gh.pr.comment": () => { clock += 400; return { ok: true }; } };
  const r = await drainOutbox({ db: db4, handlers, max: 10, budgetMs: 1000, now: () => clock });

  check(r.outOfTime === true, "a pass that runs out of time says so", JSON.stringify({ outOfTime: r.outOfTime, done: r.done.length }));
  // A RANGE, not an exact count. The exact number depends on the reserve fraction,
  // and pinning it makes this test fail whenever that is tuned -- which is the
  // brittleness the budget exists to avoid, moved into its own test. What matters
  // is that it did some work and stopped short of all of it.
  check(r.done.length > 0 && r.done.length < 6,
    "and stops after the budget rather than after `max`", `${r.done.length} of 6`);
  const left = db4.prepare(`SELECT count(*) n FROM outbox WHERE status='pending'`).get().n;
  check(left === 6 - r.done.length,
    "leaving the rest pending for the next tick, exactly as running out of rows does", String(left));
  // Control: the same six drain fully when the budget is not the binding
  // constraint, so the assertion above is about the budget and not about the
  // drainer having stopped working.
  // --- and the budget bounds the delivery INSIDE it, not just the gap between --
  //
  // Checking only before leasing left the first slow delivery free to spend its
  // whole lease. A bound the work inside it cannot see is not a bound: the pass
  // was over by the time the check came round again.
  {
    let seen = null;
    const slow = { "gh.pr.comment": (a, { api }) => { api(["-X", "GET", "x"]); return { ok: true }; } };
    const spy = (a, opts) => { seen = opts?.timeoutMs ?? null; return { ok: true, out: "" }; };
    const d5 = mkdtempSync(join(tmpdir(), "reeve-inner-"));
    const db5 = open(join(d5, "s.db"));
    tx(db5, () => enqueue(db5, { idemKey: "inner", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));
    // A generous lease and a small budget: the lease would allow 250s, the budget
    // allows 2s, and the delivery must be given the SMALLER.
    await drainOutbox({ db: db5, handlers: slow, api: spy, max: 1, leaseSeconds: 300, budgetMs: 2000 });
    check(seen !== null && seen <= 2000,
      "a delivery is bounded by what the PASS has left, not only by its lease", `timeoutMs=${seen}`);
    // Control: with a budget larger than the lease allows, the lease is what binds
    // — so the assertion above is about the minimum and not about the budget
    // having simply replaced the lease.
    tx(db5, () => enqueue(db5, { idemKey: "inner2", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));
    await drainOutbox({ db: db5, handlers: slow, api: spy, max: 1, leaseSeconds: 10, budgetMs: 600_000 });
    check(seen !== null && seen <= 10_000,
      "control: and by its lease when that is the smaller of the two", `timeoutMs=${seen}`);
    db5.close();
    rmSync(d5, { recursive: true, force: true });
  }

  const before2 = db4.prepare(`SELECT count(*) n FROM outbox WHERE status='pending'`).get().n;
  const r2 = await drainOutbox({ db: db4, handlers, max: 10, budgetMs: 100_000, now: () => clock });
  check(r2.done.length === before2 && r2.outOfTime === false,
    "control: with room, the remainder drains and the pass does not report a cutoff",
    `${r2.done.length} of ${before2}, outOfTime=${r2.outOfTime}`);

  db4.close();
  rmSync(d4, { recursive: true, force: true });
}

// --- a handler cannot widen its own deadline ---------------------------------
{
  // `api(a, { timeoutMs: left, ...opts })` put the handler's options LAST, so a
  // handler passing a conventional per-call timeout replaced the remaining
  // deadline with its own -- and the synchronous `gh` call could then outrun both
  // the pass budget and the lease, reopening the duplicate-delivery race the
  // wrapper exists to close.
  const d6 = mkdtempSync(join(tmpdir(), "reeve-clamp-"));
  const db6 = open(join(d6, "s.db"));
  const seen = [];
  const spy = (a, opts) => { seen.push(opts?.timeoutMs ?? null); return { ok: true, out: "" }; };
  // A handler that asks for ten minutes, inside a two-second budget.
  const greedy = { "gh.pr.comment": (a, { api }) => { api(["-X", "GET", "x"], { timeoutMs: 600_000 }); return { ok: true }; } };
  tx(db6, () => enqueue(db6, { idemKey: "greedy", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));
  await drainOutbox({ db: db6, handlers: greedy, api: spy, max: 1, leaseSeconds: 300, budgetMs: 2000 });
  check(seen[0] !== null && seen[0] <= 2000,
    "a handler asking for more time than the pass has does not get it", `timeoutMs=${seen[0]}`);

  // Control: a handler asking for LESS still gets less, so this is a clamp and not
  // an override -- a wrapper that simply ignored the handler would pass the check
  // above while taking away a legitimate, tighter bound.
  const modest = { "gh.pr.comment": (a, { api }) => { api(["-X", "GET", "x"], { timeoutMs: 50 }); return { ok: true }; } };
  tx(db6, () => enqueue(db6, { idemKey: "modest", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));
  await drainOutbox({ db: db6, handlers: modest, api: spy, max: 1, leaseSeconds: 300, budgetMs: 60_000 });
  check(seen[1] === 50, "control: and one asking for less keeps its own tighter bound", `timeoutMs=${seen[1]}`);

  db6.close();
  rmSync(d6, { recursive: true, force: true });
}

// --- the pass budget covers recovery, not only delivery -----------------------
{
  // Recovery updates every expired inflight row and emits an event per crash-loop
  // dead letter. With a troubled queue that is real work, and starting the clock
  // afterwards meant it cost nothing against the budget -- the pass then still got
  // its full sixty seconds. A whole-pass bound that excludes part of the pass is
  // not a whole-pass bound.
  const d7 = mkdtempSync(join(tmpdir(), "reeve-recovclock-"));
  const db7 = open(join(d7, "s.db"));
  tx(db7, () => enqueue(db7, { idemKey: "r1", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "b" } }));
  // A clock that jumps during recovery, standing in for a slow one.
  let clock = 0, recovered = false;
  const now = () => { if (!recovered) return clock; return clock; };
  const handlers = { "gh.pr.comment": () => ({ ok: true }) };
  // Lease it and let it expire, so recovery has work to do.
  leaseOutbox(db7, { worker: "dead", leaseSeconds: -5, kinds: ["gh.pr.comment"] });
  // The budget is already spent by the time recovery finishes.
  clock = 0;
  const r = await drainOutbox({ db: db7, handlers, max: 5, budgetMs: 1000,
                                now: () => { const v = clock; clock += 2000; return v; } });
  check(r.recovered >= 1, "control: recovery had work to do", String(r.recovered));
  check(r.done.length === 0 && r.outOfTime === true,
    "time spent recovering counts against the pass budget", JSON.stringify({ done: r.done.length, outOfTime: r.outOfTime }));
  db7.close();
  rmSync(d7, { recursive: true, force: true });
}

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
  const history = Array.from({ length: 150 }, (_, i) => ({ id: i, user: "someone", body: `old ${i}` }));
  // Models `--jq` filtering at the source, which is what production now does: gh
  // returns matching IDS, one per line, not the discussion. That is the whole
  // point -- a long thread's full JSON exceeds the subprocess buffer, the read
  // fails, and a failed read falls through and posts the duplicate it exists to
  // prevent. Filtering at the source removes the thread's length from the answer.
  const ME = "reeve-merge-policy[bot]";
  // Models `--jq` filtering at the source, including the AUTHOR test. gh returns
  // matching ids and nothing else -- that is what keeps a long thread from
  // overrunning the subprocess buffer, and what keeps a forged marker from ever
  // reaching the handler.
  const api = args => {
    if (args.includes("GET")) {
      lists++;
      if (args.includes("--paginate")) paginated++;
      const jq = args[args.indexOf("--jq") + 1] ?? "";
      const wantBody = /contains\("([^"]+)"\)/.exec(jq)?.[1] ?? null;
      const wantUser = /\.user\.login == "([^"]+)"/.exec(jq)?.[1] ?? null;
      const all = [...history, ...posted];
      const pages = args.includes("--paginate") ? all : all.slice(0, 100);
      const ids = wantBody === null ? [] : pages
        .filter(c => (wantUser === null || c.user === wantUser) && c.body.includes(wantBody))
        .map(c => c.id);
      return { ok: true, out: ids.join("\n") };
    }
    posted.push({ id: 1000 + posted.length, user: ME, body: args[args.indexOf("-f") + 1].replace(/^body=/, "") });
    return { ok: true, out: JSON.stringify({ id: 1000 + posted.length - 1 }) };
  };
  const args = { nwo: "o/r", pr: 1, body: "@codex review" };

  const first = ghPrComment(args, { api, idemKey: key, actor: ME });
  check(first.ok && posted.length === 1, "the first delivery posts the comment", JSON.stringify(first));
  check(posted[0].body.includes(markerFor(key)), "carrying an invisible key that identifies it", posted[0].body);
  // The pre-check runs on the FIRST attempt too. Gating it on the attempt count
  // was an optimisation that could not survive a restore: roll the database back
  // to before a delivery and the comment is still on GitHub while the row returns
  // with attempts=0, so a "first" attempt posts the same trigger again. Only
  // GitHub knows what is on GitHub.
  check(lists === 1, "and the first attempt DID check GitHub, because a local counter cannot know about a restore",
    `${lists} list call(s)`);

  const second = ghPrComment(args, { api, idemKey: key, actor: ME });
  check(second.ok, "a retry after a crash still reports success", JSON.stringify(second));
  check(posted.length === 1, "and does NOT post a second comment", `posted ${posted.length}`);
  check(second.result.alreadyThere === true, "because it recognised its own earlier one", JSON.stringify(second.result));
  check(paginated === lists && lists >= 2, "having read EVERY page, not the arbitrary first one",
    `${paginated} of ${lists} list call(s) paginated`);

  // Control: a DIFFERENT key must still post. Without this the assertion above
  // passes equally well on a handler that has simply stopped posting anything.
  const other = ghPrComment(args, { api, idemKey: "review-request:o/r:1:def:codex", actor: ME });
  check(other.ok && posted.length === 2, "control: a different effect still posts", `posted ${posted.length}`);

  // --- a marker someone ELSE wrote is not evidence that reeve delivered --------
  //
  // The key is built from public values: repository, pull request, head, reviewer
  // login. Anyone who can comment can construct it. Without an author test, a
  // contributor could post the marker during a transient failure and the retry
  // would settle `done` without ever requesting the review -- a required reviewer
  // silently never summoned, which is worse than a duplicate comment because
  // nothing looks wrong.
  const forgedKey = "review-request:o/r:1:xyz:codex";
  history.push({ id: 500, user: "a-contributor", body: `nice work ${markerFor(forgedKey)}` });
  const before = posted.length;
  const forged = ghPrComment(args, { api, idemKey: forgedKey, actor: ME });
  check(forged.ok && posted.length === before + 1,
    "a marker posted by someone else does not suppress the delivery", JSON.stringify(forged));
  check(forged.result.alreadyThere === false, "and is not mistaken for reeve's own", JSON.stringify(forged.result));

  // Control: the same marker from REEVE does suppress it, so the assertion above
  // is about the author and not about the marker having stopped working.
  const mineKey = "review-request:o/r:1:pqr:codex";
  posted.push({ id: 900, user: ME, body: `x ${markerFor(mineKey)}` });
  const at = posted.length;
  const own = ghPrComment(args, { api, idemKey: mineKey, actor: ME });
  check(own.ok && posted.length === at && own.result.alreadyThere === true,
    "control: the same marker from reeve DOES suppress it", JSON.stringify(own.result));

  // And with no actor known, suppression is skipped entirely: "cannot tell" is not
  // "matches". A duplicate comment is a nuisance; an unrequested review is a pull
  // request that waits forever.
  const at2 = posted.length;
  const blind = ghPrComment(args, { api, idemKey: mineKey, actor: null });
  check(blind.ok && posted.length === at2 + 1,
    "an unknown actor posts rather than trusting a marker it cannot attribute", JSON.stringify(blind.result));
}

// --- a request the head has outrun is not posted ------------------------------
{
  // Withdrawing superseded PENDING rows leaves one window open on purpose: an
  // INFLIGHT row is not deleted, because deleting one its drainer holds would
  // leave it settling into nothing. So a head that moves mid-delivery can only be
  // caught by the delivery declining. A trigger comment names no revision, so
  // posting one decided for an old head requests a review of the NEW head -- and
  // the tick that saw the new head enqueues its own, differently marked, and asks
  // again.
  let posted = 0, headReads = 0;
  const mk = (current, state = "open") => args => {
    if (args.includes(`repos/o/r/pulls/1`)) { headReads++; return { ok: true, out: `${state}\t${current}` }; }
    if (args.includes("GET")) return { ok: true, out: "" };
    posted++; return { ok: true, out: JSON.stringify({ id: 1 }) };
  };
  const args = { nwo: "o/r", pr: 1, body: "@codex review", head: "aaa" };

  const stale = ghPrComment(args, { api: mk("bbb"), idemKey: "k-stale", actor: "x[bot]" });
  check(stale.ok && posted === 0, "a request decided for an old head is not posted", JSON.stringify(stale));
  check(stale.result.superseded === true, "and says it was overtaken rather than delivered", JSON.stringify(stale.result));
  check(headReads === 1, "control: it actually asked what the head is", String(headReads));

  // Control: the SAME call at the head it was decided for does post. Without it,
  // the assertion above passes on a handler that has stopped posting anything.
  const fresh = ghPrComment(args, { api: mk("aaa"), idemKey: "k-fresh", actor: "x[bot]" });
  check(fresh.ok && posted === 1, "control: at its own head the same request posts", JSON.stringify(fresh.result));

  // A pull request that has CLOSED is not asked for a review either. It normally
  // keeps its head, so a head check alone lets the request through to something
  // the watcher already treats as finished -- asking for a review nobody will do,
  // or failing terminally and raising a dead letter naming a pull request that is
  // over.
  const at0 = posted;
  const closed = ghPrComment(args, { api: mk("aaa", "closed"), idemKey: "k-closed", actor: "x[bot]" });
  check(closed.ok && posted === at0, "a request to a CLOSED pull request is not posted", JSON.stringify(closed.result));
  check(/closed/.test(String(closed.result.reason)), "and says which state stopped it", JSON.stringify(closed.result));
  const merged = ghPrComment(args, { api: mk("aaa", "merged"), idemKey: "k-merged", actor: "x[bot]" });
  check(merged.ok && posted === at0, "nor to a merged one", JSON.stringify(merged.result));

  // An UNREADABLE head does not discard. Absence of evidence is not evidence of
  // absence, and a stale comment costs far less than a review request dropped on a
  // transient read failure.
  const blindApi = a => {
    if (a.includes(`repos/o/r/pulls/1`)) return { ok: false, err: "HTTP 502" };
    if (a.includes("GET")) return { ok: true, out: "" };
    posted++; return { ok: true, out: JSON.stringify({ id: 2 }) };
  };
  const at = posted;
  const blind = ghPrComment(args, { api: blindApi, idemKey: "k-blind", actor: "x[bot]" });
  check(blind.ok && posted === at + 1, "an unreadable head posts rather than dropping the request",
    JSON.stringify(blind.result));

  // And an effect with no head at all is unaffected, so other kinds of comment
  // do not silently acquire a revision check they were never given one for.
  const at2 = posted;
  const noHead = ghPrComment({ nwo: "o/r", pr: 1, body: "hello" }, { api: mk("zzz"), idemKey: "k-nohead", actor: "x[bot]" });
  check(noHead.ok && posted === at2 + 1, "an effect carrying no head is posted as before", JSON.stringify(noHead.result));
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
  // Named, because every failure that lands here LOOKS like "no marker found": a
  // timeout, a truncated buffer, a rate limit. Reading any of them as absence is
  // how the check meant to prevent a duplicate causes one.
  for (const err of [{ ok: false, err: "gh api exceeded 30000ms and was killed", timedOut: true },
                     { ok: false, err: "gh api output exceeded 1048576 bytes", truncated: true }]) {
    const before = posted.length;
    const q = ghPrComment({ nwo: "o/r", pr: 1, body: "b" },
                          { api: a => (a.includes("GET") ? err : (posted.push("y"), { ok: true, out: "{}" })), idemKey: "k2", attempt: 2 });
    check(q.ok && posted.length === before + 1,
      `a ${err.timedOut ? "timed-out" : "truncated"} pre-check posts rather than assuming delivered`, JSON.stringify(q));
  }
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
