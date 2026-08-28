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
import { ghIssueCreate, ghThreadResolve, HANDLERS, markerFor } from "../src/outbox/effects.mjs";
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
    { when: a => a.includes("--paginate"), then: { ok: true, out: "77" } },
  ]);
  const r = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                          { api, idemKey: "k", actor: "reeve[bot]" });
  check(r.ok && r.result.number === 77 && r.result.alreadyThere === true,
    "an issue already carrying the marker is adopted rather than filed again", JSON.stringify(r));
  check(!calls.some(a => a.includes("POST")), "and nothing was posted", JSON.stringify(calls));
  const look = calls.find(a => a.includes("--paginate"));
  check(look.includes("state=all"), "the search covers CLOSED issues too", JSON.stringify(look));
  check(look.some(x => String(x).includes("reeve[bot]")),
    "and it checks the AUTHOR, so a planted marker cannot make reeve settle having filed nothing");

  // An unreadable check is not evidence that no issue exists — but findings never
  // filed are findings nobody acts on, so it files. Same ruling as gh.pr.comment.
  const blind = recorder([{ when: a => a.includes("--paginate"), then: { ok: false, err: "timeout" } },
                          { when: a => a.includes("POST"), then: { ok: true, out: JSON.stringify({ number: 9 }) } }]);
  const r2 = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                           { api: blind.api, idemKey: "k", actor: "reeve[bot]" });
  check(r2.ok && r2.result.number === 9,
    "an UNREADABLE duplicate check files anyway, because absence of evidence is not evidence of absence");
}

// --- reconciling may confirm, never act ----------------------------------------
{
  const definite = recorder([{ when: a => a.includes("--paginate"), then: { ok: true, out: "" } }]);
  const r = ghIssueCreate({ nwo: "o/r", title: "t", body: "b" },
                          { api: definite.api, idemKey: "k", actor: "reeve[bot]", reconcileOnly: true });
  check(!r.ok && r.retryable === false,
    "a definite 'no such issue' with the budget spent is terminal", JSON.stringify(r));
  check(!definite.calls.some(a => a.includes("POST")), "and it filed nothing");

  const unreadable = recorder([{ when: a => a.includes("--paginate"), then: { ok: false, err: "500" } }]);
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

  // Refused rather than rebuilt when it would DISCARD queued effects, because each
  // one is a decision already durable whose visible half has not happened.
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
  raw2.exec(`INSERT INTO outbox(idem_key,kind,args,created_at,updated_at) VALUES('queued','gh.pr.comment','{}',0,0)`);
  raw2.close();
  let refusal = null;
  try { open(path2); } catch (e) { refusal = e; }
  check(refusal !== null, "a store with QUEUED effects is refused rather than rebuilt", String(refusal));
  check(/QUEUED SIDE EFFECTS/.test(String(refusal?.message)),
    "and says what would be lost, rather than only that it refused", String(refusal?.message));
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
