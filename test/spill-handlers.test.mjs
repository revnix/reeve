// The two effects a spill needs, and the rule that they are the ONLY way out.
//
// A spill files one issue and then says so on the threads it is spilling. The
// issue's number does not exist until the create has delivered, which is why these
// are two rows joined by an edge rather than one handler — see src/outbox/depends.mjs.
//
// The assertion this file exists for is the last block: not "the handlers work"
// but "nothing reaches GitHub except through an injected api". A handler that
// reached for `gh` itself would pass every behavioural test here and still bypass
// the outbox entirely, which is the one failure the outbox exists to prevent.
import { ghIssueCreate, ghThreadResolve, HANDLERS, markerFor,
         UNGATED_BY_REVIEW_ACTIONS, isUngatedByReviewActions,
         permittedHandlers } from "../src/outbox/effects.mjs";
import { open, tx, enqueue } from "../src/db/ops.mjs";
import { drainOutbox } from "../src/outbox/drain.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};
const fresh = tag => open(join(mkdtempSync(join(tmpdir(), `reeve-spill-${tag}-`)), "state.db"));

// A recorder that also answers. `replies` is consulted in order; anything
// unmatched answers ok with empty output, which is the shape `gh` gives for a
// query that found nothing.
// `Array.includes` is exact ELEMENT equality, not a substring search — a matcher
// written as `a.includes("query=query")` silently never fires, the recorder falls
// through to its default answer, and the test then measures the default rather
// than the case it names. That happened here on the first run.
const has = (argv, text) => argv.some(x => String(x).includes(text));

const recorder = (replies = []) => {
  const calls = [];
  const api = argv => {
    calls.push(argv);
    const hit = replies.find(r => !r.used && r.when(argv));
    if (hit) { hit.used = true; return hit.then; }
    return { ok: true, out: "" };
  };
  return { api, calls };
};

// --- filing the issue ----------------------------------------------------------
{
  const { api, calls } = recorder([
    { when: a => a.includes("POST"), then: { ok: true, out: JSON.stringify({ number: 412 }) } },
  ]);
  const r = ghIssueCreate({ nwo: "o/r", title: "Remaining findings", body: "three left", labels: ["spill"] },
                          { api, idemKey: "k1", actor: "reeve[bot]" });
  check(r.ok && r.result.number === 412, "an issue is filed and its NUMBER comes back", JSON.stringify(r));
  check(r.result.alreadyThere === false, "and it is reported as newly filed");

  const post = calls.find(a => a.includes("POST"));
  check(post.some(x => String(x).includes(markerFor("k1"))),
    "the body carries the effect's marker, so a retry can recognise it");
  check(post.some(x => String(x) === "labels[]=spill"), "and the labels are passed", JSON.stringify(post));

  // The number is the whole point: the dependent replies substitute it.
  const noNumber = recorder([{ when: a => a.includes("POST"), then: { ok: true, out: "not json" } }]);
  const r2 = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                           { api: noNumber.api, idemKey: "k2", actor: "reeve[bot]" });
  check(!r2.ok && r2.retryable === true,
    "an issue filed whose number cannot be read is retryable, not a silent success", JSON.stringify(r2));

  const bad = ghIssueCreate({ nwo: "o/r" }, { api, idemKey: "k3" });
  check(!bad.ok && bad.retryable === false, "missing arguments fail terminally rather than being retried");
}

// --- not filing it twice -------------------------------------------------------
{
  // `state=all`, because an issue somebody already closed still exists and
  // re-filing it is the duplicate this prevents.
  const { api, calls } = recorder([
    { when: a => a.some(x => String(x).includes("repos/o/r/issues")), then: { ok: true, out: "77" } },
  ]);
  const r = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                          { api, idemKey: "k", actor: "reeve[bot]" });
  check(r.ok && r.result.number === 77 && r.result.alreadyThere === true,
    "an issue already carrying the marker is adopted rather than filed again", JSON.stringify(r));
  check(!calls.some(a => a.includes("POST")), "and nothing was posted", JSON.stringify(calls));
  const look = calls.find(a => a.some(x => String(x).includes("repos/o/r/issues")));
  check(look.includes("state=all"), "the search covers CLOSED issues too", JSON.stringify(look));
  check(look.includes("sort=created") && look.includes("direction=desc") && !look.includes("--paginate"),
    "and it is BOUNDED and newest-first rather than walking the whole issue history",
    JSON.stringify(look));
  check(look.some(x => String(x).includes("reeve[bot]")),
    "and it checks the AUTHOR, so a planted marker cannot make reeve settle having filed nothing");

  // An unreadable check is not evidence that no issue exists — but findings never
  // filed are findings nobody acts on, so it files. Same ruling as gh.pr.comment.
  const blind = recorder([{ when: a => a.some(x => String(x).includes("repos/o/r/issues")), then: { ok: false, err: "timeout" } },
                          { when: a => a.includes("POST"), then: { ok: true, out: JSON.stringify({ number: 9 }) } }]);
  const r2 = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                           { api: blind.api, idemKey: "k", actor: "reeve[bot]" });
  check(r2.ok && r2.result.number === 9,
    "an UNREADABLE duplicate check files anyway, because absence of evidence is not evidence of absence");
}

// --- reconciling may confirm, never act ----------------------------------------
{
  const definite = recorder([{ when: a => a.some(x => String(x).includes("repos/o/r/issues")), then: { ok: true, out: "" } }]);
  const r = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                          { api: definite.api, idemKey: "k", actor: "reeve[bot]", reconcileOnly: true });
  check(!r.ok && r.retryable === false,
    "a definite 'no such issue' with the budget spent is terminal", JSON.stringify(r));
  check(!definite.calls.some(a => a.includes("POST")), "and it filed nothing");

  const unreadable = recorder([{ when: a => a.some(x => String(x).includes("repos/o/r/issues")), then: { ok: false, err: "500" } }]);
  const r2 = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                           { api: unreadable.api, idemKey: "k", actor: "reeve[bot]", reconcileOnly: true });
  check(!r2.ok && r2.retryable === true,
    "while an unreadable one is retryable — 'cannot tell' is not 'did not happen'", JSON.stringify(r2));
  check(!unreadable.calls.some(a => a.includes("POST")), "and it filed nothing either");
}

// --- resolving a thread --------------------------------------------------------
{
  const already = recorder([{ when: a => has(a, "query=query"), then: { ok: true, out: "true" } }]);
  const r = ghThreadResolve({ threadId: "T1" }, { api: already.api });
  check(r.ok && r.result.alreadyThere === true,
    "a thread that is already resolved settles ok WITHOUT a write", JSON.stringify(r));
  check(!already.calls.some(a => has(a, "mutation")),
    "and no mutation was sent", JSON.stringify(already.calls));

  const open2 = recorder([{ when: a => has(a, "query=query"), then: { ok: true, out: "false" } },
                          { when: a => has(a, "mutation"), then: { ok: true, out: "{}" } }]);
  const r2 = ghThreadResolve({ threadId: "T2" }, { api: open2.api });
  check(r2.ok && r2.result.alreadyThere === false, "an unresolved thread is resolved", JSON.stringify(r2));

  // `gh api graphql`, not `gh api api graphql`. The seam supplies the "api" word,
  // and passing it again fails at run time and in no test that mocks the seam —
  // which is exactly what happened before this assertion existed.
  const q = open2.calls.find(a => has(a, "query=query"));
  check(q[0] === "graphql", "the GraphQL call does not repeat the api word the seam already supplies", JSON.stringify(q));

  const bad = ghThreadResolve({}, { api: open2.api });
  check(!bad.ok && bad.retryable === false, "a missing thread id fails terminally");
}

// --- the widened CHECK reaches a store that predates it ------------------------
{
  // ALTER TABLE cannot touch a CHECK, and CREATE TABLE IF NOT EXISTS does nothing
  // to a table that exists — so without the rebuild an old store keeps the old
  // list and the failure appears at the first INSERT of the new kind, inside the
  // daemon, on the first spill.
  const dir = mkdtempSync(join(tmpdir(), "reeve-spill-old-"));
  const path = join(dir, "old.db");
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE outbox (
              id INTEGER PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL CHECK (kind IN ('gh.pr.comment','notify')),
              run_id TEXT, args TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
              not_before INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER NOT NULL DEFAULT 0,
              result TEXT, last_error TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`);
  const before = raw.prepare("SELECT sql FROM sqlite_master WHERE name='outbox'").get().sql;
  raw.close();
  check(!before.includes("gh.issue.create"), "control: the fixture's CHECK genuinely lacks the new kind");

  const db = open(path);
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='outbox'").get().sql;
  check(ddl.includes("gh.issue.create"), "opening it widens the CHECK");
  const id = tx(db, () => enqueue(db, { idemKey: "i", kind: "gh.issue.create", args: { nwo: "o/r", title: "t", body: "b" } }));
  check(Number.isInteger(id), "and the new kind can actually be enqueued", String(id));

  // ROWS SURVIVE, and this is the case that would have bricked every armed
  // deployment. `settleOutbox` marks a delivered effect `done` and never deletes
  // it, so any store that has ever delivered anything holds rows for ever —
  // refusing on a row count made the error's own advice ("drain the queue")
  // impossible to satisfy, and the daemon would never open again.
  const dir2 = mkdtempSync(join(tmpdir(), "reeve-spill-full-"));
  const path2 = join(dir2, "full.db");
  const raw2 = new DatabaseSync(path2);
  raw2.exec(`CREATE TABLE outbox (
               id INTEGER PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE,
               kind TEXT NOT NULL CHECK (kind IN ('gh.pr.comment','notify')),
               run_id TEXT, args TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
               not_before INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER NOT NULL DEFAULT 0,
               result TEXT, last_error TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`);
  // WITH ITS INDEXES, which is the whole point of the assertion below. Without
  // them the rename has nothing to carry, and the check that index names were
  // freed passes for a fixture that could never have exhibited the defect.
  raw2.exec(`CREATE INDEX outbox_due ON outbox(not_before, id) WHERE status='pending'`);
  raw2.exec(`CREATE INDEX outbox_inflight ON outbox(lease_expires_at) WHERE status='inflight'`);
  raw2.exec(`INSERT INTO outbox(id,idem_key,kind,args,status,attempts,created_at,updated_at)
             VALUES(7,'delivered','gh.pr.comment','{"a":1}','done',3,111,222)`);
  raw2.exec(`INSERT INTO outbox(id,idem_key,kind,args,status,created_at,updated_at)
             VALUES(8,'queued','gh.pr.comment','{}','pending',0,0)`);
  raw2.close();

  let refusal = null;
  let db2 = null;
  try { db2 = open(path2); } catch (e) { refusal = e; }
  check(refusal === null, "a store holding delivered history still opens", String(refusal));
  check(db2.prepare("SELECT count(*) n FROM outbox").get().n === 2,
    "and every row is carried across the rebuild", String(db2?.prepare("SELECT count(*) n FROM outbox").get().n));

  const carried = db2.prepare("SELECT id, idem_key, status, attempts, args, created_at FROM outbox WHERE id=7").get();
  check(carried.idem_key === "delivered" && carried.status === "done" && carried.attempts === 3,
    "with its status and counters intact", JSON.stringify(carried));
  check(carried.created_at === 111, "and its original timestamps", String(carried.created_at));
  // Ids preserved, because `depends_on` points at them.
  check(carried.id === 7, "and its id, since a dependency edge points at it");
  check(db2.prepare("SELECT sql FROM sqlite_master WHERE name='outbox'").get().sql.includes("gh.issue.create"),
    "while the constraint really was widened");
  check(db2.prepare("SELECT count(*) n FROM sqlite_master WHERE name='_reshape_outbox'").get().n === 0,
    "and the staging table is gone");
  // Indexes follow a rename and KEEP their names, so the staged table would hold
  // `outbox_due` hostage and schema.sql's IF NOT EXISTS would quietly do nothing —
  // leaving the rebuilt table unindexed on exactly the stores that were upgraded.
  for (const idx of ["outbox_due", "outbox_inflight"])
    check(db2.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(idx)?.tbl_name === "outbox",
      `${idx} belongs to the rebuilt table, not to the staging one`,
      JSON.stringify(db2.prepare("SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?").get(idx)));

  // AN INTERRUPTED REBUILD IS RECOVERED, not discarded. The rename autocommits, so
  // a process dying before the copy leaves the rows in staging and no real table.
  // Recreating an empty one and dropping staging on top would destroy every queued
  // and delivered effect — the worst outcome this table can have.
  const dir3 = mkdtempSync(join(tmpdir(), "reeve-spill-crash-"));
  const path3 = join(dir3, "crash.db");
  const raw3 = new DatabaseSync(path3);
  raw3.exec(`CREATE TABLE _reshape_outbox (
               id INTEGER PRIMARY KEY, idem_key TEXT NOT NULL UNIQUE,
               kind TEXT NOT NULL, run_id TEXT, args TEXT NOT NULL,
               status TEXT NOT NULL DEFAULT 'pending',
               attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 8,
               not_before INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER NOT NULL DEFAULT 0,
               result TEXT, last_error TEXT,
               created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`);
  raw3.exec(`INSERT INTO _reshape_outbox(id,idem_key,kind,args,status,created_at,updated_at)
             VALUES(4,'survivor','gh.pr.comment','{}','pending',1,2)`);
  raw3.close();
  check(true, "control: a store is left mid-rebuild, with its rows only in staging");

  const db3 = open(path3);
  check(db3.prepare("SELECT count(*) n FROM outbox").get().n === 1,
    "an interrupted rebuild is RECOVERED on the next open rather than discarded",
    String(db3.prepare("SELECT count(*) n FROM outbox").get().n));
  check(db3.prepare("SELECT idem_key, status FROM outbox WHERE id=4").get()?.idem_key === "survivor",
    "with the row intact");
  check(db3.prepare("SELECT count(*) n FROM sqlite_master WHERE name='_reshape_outbox'").get().n === 0,
    "and the staging table cleaned up afterwards");
  // The queued row is still queued: a rebuild must not deliver or discard it.
  check(db2.prepare("SELECT status FROM outbox WHERE id=8").get().status === "pending",
    "a pending effect is still pending afterwards, neither delivered nor lost");
}

// --- the review switch governs EVERY effect, by default ------------------------
{
  // The gate was an allowlist of gated kinds, so anything not named took the
  // unconditional branch. That is fail-open by construction, and it is how
  // gh.issue.create arrived unprotected: adding it to HANDLERS made it drainable
  // and nothing gated it, so an operator turning the switch off would still have
  // had a spill issue filed from a row queued earlier.
  //
  // Asserted over the WHOLE handler set rather than over the kinds this change
  // adds, so a handler added later is covered by this test without anyone
  // remembering to extend it.
  for (const kind of Object.keys(HANDLERS))
    check(!isUngatedByReviewActions(kind),
      `${kind} is governed by the review switch`, kind);

  // Double duty, and the second is the important one.
  //
  // As a CONTROL it stops the loop above passing vacuously — with a non-empty
  // exemption set the loop could be satisfied by kinds nobody gated.
  //
  // As an ASSERTION it makes the first exemption argue for itself. An empty set is
  // the strongest statement this file can make, and it is also the easiest thing to
  // quietly add one entry to; a diff that turns this red cannot be read past.
  check(UNGATED_BY_REVIEW_ACTIONS.length === 0,
    "the exemption list is EMPTY — adding to it must fail this and be argued for",
    String(UNGATED_BY_REVIEW_ACTIONS.length));

  // A frozen Set is not immutable: `Object.freeze` leaves `.add()` working, so any
  // importer could grant an exemption at run time from anywhere in the process. An
  // exemption must be a source-level decision a reviewer sees.
  let mutated = false;
  try { UNGATED_BY_REVIEW_ACTIONS.push("gh.issue.create"); mutated = true; } catch { /* frozen */ }
  check(!mutated && !isUngatedByReviewActions("gh.issue.create"),
    "and it cannot be added to at run time", String(mutated));

  // And the BEHAVIOUR, not only the declaration. Asserting the exemption set is
  // empty proves what is declared and nothing about whether anything reads it —
  // the first version of this change shipped with the daemon still applying its own
  // inline allowlist, and a stub reverting that left every assertion above green.
  check(Object.keys(permittedHandlers(HANDLERS, true)).length === Object.keys(HANDLERS).length,
    "with the switch ON every handler is permitted",
    JSON.stringify(Object.keys(permittedHandlers(HANDLERS, true))));
  check(Object.keys(permittedHandlers(HANDLERS, false)).length === 0,
    "and with the switch OFF none is — including any handler added later",
    JSON.stringify(Object.keys(permittedHandlers(HANDLERS, false))));

  // The specific case that was live: a queued issue-create drained after the
  // operator turned the switch off.
  check(permittedHandlers(HANDLERS, false)["gh.issue.create"] === undefined,
    "a queued spill issue is NOT filed once the switch is off");

  // WHAT THIS DOES NOT COVER, stated rather than implied.
  //
  // These assertions exercise the rule. They do not prove the daemon CALLS it:
  // stubbing `permittedHandlers(...)` back to a bare `ctx.handlers ?? HANDLERS`
  // in the tick leaves every assertion here green. Reaching that needs a test
  // that drives the tick, and the tick is being restructured in another change.
  //
  // Named here because an unstated gap reads as covered, and this is the third
  // time in two pull requests that a correct mechanism turned out to have nothing
  // plugged into it.
}

// --- nothing reaches GitHub except through an injected api ---------------------
{
  // The assertion this file exists for.
  //
  // Every test above proves a handler DOES the right thing when called. None of
  // them would notice a handler that also reached for `gh` on its own — which
  // would bypass the outbox's fence, its budget and its idempotency entirely,
  // and that is the single failure the outbox exists to prevent.
  //
  // Provenance is established by WHICH recorder saw the call, never by what the
  // caller says about itself. Two distinct instances: one handed to the drain, one
  // standing for everywhere else. A handler cannot forge the tag because it does
  // not apply the tag — the recorder that observed the call does. That refinement
  // came from the session working on the provider-session extraction.
  const drainRecorder = recorder([
    { when: a => a.includes("POST"), then: { ok: true, out: JSON.stringify({ number: 5 }) } },
  ]);
  const elsewhere = recorder();

  const db = fresh("provenance");
  tx(db, () => enqueue(db, { idemKey: "file-it", kind: "gh.issue.create",
                             args: { nwo: "o/r", title: "t", body: "b" } }));
  await drainOutbox({ db, handlers: HANDLERS, api: drainRecorder.api, actor: "reeve[bot]",
                      max: 5, budgetMs: 600_000 });

  // The VACUITY half, and it is not decoration. Without it every assertion below
  // is satisfied by a fixture that never reached the code at all — which is
  // precisely how three assertions in the previous pull request came to be green
  // and worthless.
  check(drainRecorder.calls.length > 0,
    "control: the drain really did reach GitHub, so the next assertion is about something",
    String(drainRecorder.calls.length));
  check(elsewhere.calls.length === 0,
    "and EVERY call came through the api the drain was given — nothing bypassed the outbox",
    JSON.stringify(elsewhere.calls));

  // A deliberately wrong handler, so the pair is shown to be able to fail. Without
  // this the block asserts that a recorder nobody used recorded nothing.
  const rogue = { "gh.issue.create": (args, { api }) => { elsewhere.api(["-X", "POST", "sneaky"]); return { ok: true, result: { number: 1 } }; } };
  const db2 = fresh("rogue");
  tx(db2, () => enqueue(db2, { idemKey: "file-it", kind: "gh.issue.create",
                               args: { nwo: "o/r", title: "t", body: "b" } }));
  await drainOutbox({ db: db2, handlers: rogue, api: drainRecorder.api, actor: "reeve[bot]",
                      max: 5, budgetMs: 600_000 });
  check(elsewhere.calls.length === 1,
    "control: a handler that bypasses the injected api IS observed, so the check above can fail",
    JSON.stringify(elsewhere.calls));
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
