// Section 13: the guardian's hub surface is exactly two touches -- it WRITES
// the provider scheduler and it READS pr_hold. Nothing else.
//
// Asserted at the connection, not by review. A guardian that grew a third touch
// would still pass every functional test it has; this is the only thing that
// would notice.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHubAsGuest, stripSql } from "../src/build/hubguest.mjs";
import { openHub } from "../src/build/hubdb.mjs";
import { claimProvider } from "../src/provider.mjs";   // the end-to-end guest assertion

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail) console.log("        " + detail); fail++; }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-guest-"));

const p = join(dir, "g.db");
openHub(p).close();
const g = openHubAsGuest(p);

const allowed = [
  // Transaction control: claimProvider and releaseProvider write through a
  // BEGIN IMMEDIATE, and section 10.4 requires the admission rule to be
  // evaluated under one. A table-only allowlist refuses the guardian its own
  // transaction, which is not a narrower surface -- it is a broken one.
  // Ordered so each is legal where it runs: a standalone ROLLBACK after a COMMIT
  // fails with "cannot rollback - no transaction is active", which would report
  // an allowlist refusal that never happened.
  ["BEGIN IMMEDIATE", "begin a transaction"],
  ["ROLLBACK", "roll back"],
  ["BEGIN IMMEDIATE", "begin again"],
  ["COMMIT", "commit"],
  ["SELECT * FROM provider_lease", "read provider_lease"],
  ["SELECT * FROM provider_state", "read provider_state"],
  ["INSERT INTO provider_lease(owner,repo_id,run_ref,pid,lstart,priority,status,requested_at,expires_at) VALUES('guardian',1,'r',1,'x',0,'held',1,2)", "insert a provider lease"],
  ["UPDATE provider_lease SET status='held' WHERE id=1", "update a provider lease"],
  ["DELETE FROM provider_lease WHERE id=1", "delete a provider lease"],
  ["UPDATE provider_state SET cooldown_until=1 WHERE provider='claude'", "update provider state"],
  ["SELECT * FROM pr_hold WHERE repo_id=1 AND pr=2 AND cleared_at IS NULL", "read pr_hold"],
  // maintenance_lock: every provider mutation calls assertWritable, which READS
  // the lock and DELETES it when its holder is dead. Leaving it out would mean
  // every ordinary guardian claim failed at the maintenance check before ever
  // reaching provider_lease -- one guarantee breaking another.
  ["SELECT * FROM maintenance_lock WHERE name='restore'", "read the maintenance lock"],
  ["DELETE FROM maintenance_lock WHERE name='restore'", "reap a dead restore's lock"],
];
for (const [sql, name] of allowed) {
  let ok = true; try { g.prepare(sql); } catch { ok = false; }
  check(ok, `allowed via prepare: ${name}`);
  // exec too: production admission runs through a transaction issued with
  // exec(). A wrapper that permits a shape on prepare and refuses it on exec
  // passes every assertion here and then refuses the guardian its own
  // transaction in production.
  let okExec = true, why = null; try { g.exec(sql); } catch (e) { okExec = false; why = e.message; }
  check(okExec, `allowed via exec: ${name}`, String(why));
}

// And the real thing, end to end: a claim through a BEGIN IMMEDIATE must
// complete. Every statement-level assertion above can pass while the composite
// the guardian actually runs still fails.
{
  let why = null;
  try { claimProvider(g, { owner: "guardian", repoId: 1, runRef: "pr:1", pid: 1, lstart: "L", isAlive: () => true }); }
  catch (e) { why = e.message; }
  check(why === null, "a real claimProvider call completes through the guest connection", String(why));
  check(g.prepare("SELECT count(*) c FROM provider_lease WHERE run_ref='pr:1'").get().c === 1,
    "control: and it actually wrote a lease, so the call did more than not throw");
}

const refused = [
  ["SELECT * FROM task", "read task"],
  ["SELECT * FROM approval", "read approval"],
  ["SELECT * FROM merge_decision", "read merge decisions"],
  ["UPDATE pr_hold SET cleared_at=1", "WRITE pr_hold"],
  ["INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at) VALUES('t',1,2,'s','cancel',1)", "insert a pr_hold"],
  ["INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count) VALUES('bt:1:x',1,1,1,0)", "write a builder escalation"],
  ["INSERT INTO outbox(idempotency_key,kind,task_generation,fence,args,created_at,updated_at) VALUES('k','notify',1,1,'{}',1,1)", "enqueue an effect"],
  ["DROP TABLE task", "drop anything"],
  ["ATTACH DATABASE 'other.db' AS o", "attach another database"],
  ["PRAGMA writable_schema=ON", "reach the schema sideways"],
  // A verb-and-table extraction does not enforce a table boundary: the FROM
  // clause names only the FIRST table. Each of these reaches a forbidden table
  // through a permitted one.
  ["SELECT * FROM provider_lease JOIN task ON 1=1", "join a forbidden table onto a permitted one"],
  ["SELECT (SELECT count(*) FROM approval) FROM provider_lease", "read a forbidden table in a subquery"],
  ["SELECT * FROM provider_lease UNION SELECT * FROM merge_decision", "union a forbidden table"],
  ["INSERT INTO provider_lease SELECT * FROM merge_decision", "insert FROM a forbidden table"],
  // Multi-statement: an exec wrapper that validates only the FIRST statement
  // lets everything after the semicolon through. The authorizer sees each
  // accessed object regardless of how many statements the string carries.
  ["SELECT * FROM provider_lease; SELECT * FROM task", "reach a forbidden table after a semicolon"],
  ["BEGIN IMMEDIATE; DELETE FROM approval", "reach a forbidden table after a permitted statement"],
];

// The non-statement APIs are the other half of the surface. Measured on node
// v24.17.0, DatabaseSync exposes seventeen methods; gating prepare and exec
// leaves the mutation-capable ones open -- and setAuthorizer would let the
// holder switch off the thing restraining it.
//
// ABSENT, not merely throwing. Calling most of these with no arguments raises a
// TypeError on the RAW handle too, so "it threw" is satisfied by the very thing
// this is meant to exclude -- six of these seven passed against an unwrapped
// DatabaseSync. The question is whether the method is reachable at all.
const SEALED = ["setAuthorizer", "applyChangeset", "deserialize", "loadExtension",
                "enableLoadExtension", "createSession", "serialize"];
for (const m of SEALED) {
  check(typeof g[m] !== "function",
    `refused: the non-statement API ${m}() is not present on the guest`,
    `typeof g.${m} === ${typeof g[m]}`);
}
// CONTROL: the raw handle DOES have them, so the assertions above are about the
// facade rather than about node:sqlite having dropped the methods.
//
// DERIVED FROM THIS BUILD, not asserted against a fixed name. `serialize` is
// absent on some Node 24.x that satisfy the package's `>=24` engine, so naming
// it made a correctly sealed facade fail the suite on a supported runtime -- a
// control that reports a defect in the thing it is controlling for. The property
// is "the facade hides what the raw handle has", and which methods the raw
// handle has is the build's business.
{
  const raw = openHub(join(dir, "raw.db"));
  const rawHas = SEALED.filter(m => typeof raw[m] === "function");
  check(rawHas.length > 0,
    "control: an ordinary hub connection exposes some of them, so the facade is hiding something real",
    JSON.stringify({ rawHas }));
  check(typeof raw.setAuthorizer === "function",
    "control: including setAuthorizer, which this module depends on and every supported build has");
  raw.close();
}
// And the facade's surface is exactly what it means to be: anything added here
// widens the guardian's reach.
check(Object.keys(g).sort().join(",") === "close,exec,prepare",
  "the guest exposes exactly prepare, exec and close", Object.keys(g).sort().join(","));

// Transaction SHAPE, which the authorizer cannot see: it reports arg1 as
// "BEGIN" for every flavour (measured on node v24.17.0). An exclusive lock taken
// by the guardian blocks the builder and every restore.
for (const [sql, name] of [
  ["BEGIN EXCLUSIVE", "an exclusive transaction"],
  ["BEGIN DEFERRED", "a deferred transaction"],
  ["BEGIN", "a bare BEGIN, which is DEFERRED"],
  ["SELECT count(*) FROM provider_state; BEGIN EXCLUSIVE", "an exclusive BEGIN hidden behind a permitted statement"],
  ["/* guest */ BEGIN EXCLUSIVE", "an exclusive BEGIN behind a block comment"],
  ["-- guest\nBEGIN EXCLUSIVE", "an exclusive BEGIN behind a line comment"],
  ["\t/*x*/BEGIN EXCLUSIVE", "an exclusive BEGIN behind leading whitespace and a comment"],
  // The two that defeat a regex. A comment marker inside a string literal is not
  // a comment, and treating it as one hides the semicolon too.
  ["SELECT '--'; BEGIN EXCLUSIVE", "an exclusive BEGIN behind a line-comment marker in a LITERAL"],
  ["SELECT '/*'; BEGIN EXCLUSIVE", "an exclusive BEGIN behind a block-comment marker in a LITERAL"],
  ["SAVEPOINT sp", "a savepoint"],
  // QUOTED IDENTIFIERS, which are not string literals and were not handled. A
  // comment marker inside one is no more a comment than one inside a string, and
  // this exact statement was ACCEPTED before the fix -- it opened an exclusive
  // transaction, blocking the builder and every restore.
  ["SELECT count(*) AS `--` FROM provider_state; BEGIN EXCLUSIVE",
   "an exclusive BEGIN behind a comment marker in a BACKTICK identifier"],
  ["SELECT count(*) AS [--] FROM provider_state; BEGIN EXCLUSIVE",
   "an exclusive BEGIN behind a comment marker in a BRACKET identifier"],
  ["SELECT count(*) AS `x;y` FROM provider_state; BEGIN EXCLUSIVE",
   "an exclusive BEGIN behind a semicolon in a backtick identifier"],
]) {
  for (const via of ["prepare", "exec"]) {
    let why = null; try { g[via](sql); } catch (e) { why = e.message; }
    check(why !== null, `refused via ${via}: ${name}`, String(why));
  }
}

// CONTROL: the one permitted form still works through both doors, or "refuses
// every BEGIN" satisfies all ten assertions above and breaks admission in
// production.
for (const via of ["prepare", "exec"]) {
  let ok = true; try { g[via]("BEGIN IMMEDIATE"); } catch { ok = false; }
  check(ok, `control: BEGIN IMMEDIATE is still permitted via ${via}`);
  try { g.exec("ROLLBACK"); } catch {}
}

// CONTROLS for the scanner itself. A gate that refuses ordinary SQL containing a
// semicolon, a `--`, or an escaped quote inside a literal would pass every
// refusal above and then break providerdb.mjs in production -- the over-fix.
for (const [sql, name] of [
  ["SELECT * FROM provider_lease WHERE run_ref = 'a;b'", "a semicolon inside a literal"],
  ["UPDATE provider_state SET last_signature = 'x--y' WHERE provider='claude'", "a comment marker inside a literal"],
  ["SELECT * FROM provider_lease WHERE run_ref = 'it''s'", "a doubled-quote escape"],
  ["SELECT count(*) c FROM provider_state -- trailing comment", "a genuine trailing comment"],
  ["SELECT count(*) AS `total` FROM provider_state", "a backtick-quoted identifier"],
  ["SELECT count(*) AS [total] FROM provider_state", "a bracket-quoted identifier"],
]) {
  let ok = true, why = null; try { g.prepare(sql); } catch (e) { ok = false; why = e.message; }
  check(ok, `control: ordinary SQL with ${name} is still permitted`, `${sql} :: ${why}`);
}

// The function surface is an allowlist too. SQLite's built-in set varies by
// build, so authorising the ACTION rather than the NAME widens this quietly
// every time the runtime gains a function.
{
  let denied = null; try { g.prepare("SELECT fts3_tokenizer('simple')"); } catch (e) { denied = e.message; }
  check(denied !== null, "a function outside the scheduler's set is refused", String(denied));
  let ok = true; try { g.prepare("SELECT count(*), unixepoch() FROM provider_state"); } catch { ok = false; }
  check(ok, "control: the ones its own statements use are permitted");
}

// The stripper on its own, because the two literal cases above pass for the
// right reason only if it is actually neutralising them rather than the
// statement happening to be harmless.
check(stripSql("SELECT '--'; BEGIN").includes(";"),
  "the semicolon after a comment-marker LITERAL survives stripping",
  JSON.stringify(stripSql("SELECT '--'; BEGIN")));
check(!stripSql("SELECT 1 -- ; BEGIN EXCLUSIVE").includes(";"),
  "and the semicolon inside a GENUINE comment does not",
  JSON.stringify(stripSql("SELECT 1 -- ; BEGIN EXCLUSIVE")));
check(stripSql("SELECT 'a'||'b'").length === "SELECT 'a'||'b'".length,
  "stripping preserves length, so word boundaries either side of a literal survive");

for (const [sql, name] of refused) {
  let why = null; try { g.prepare(sql); } catch (e) { why = e.message; }
  check(why !== null, `refused via prepare: ${name}`);
  // exec() is the other door, and it is the one a multi-statement string walks
  // through. A wrapper that gates prepare and leaves exec open is not an
  // allowlist; the boundary promises BOTH.
  let execWhy = null; try { g.exec(sql); } catch (e) { execWhy = e.message; }
  check(execWhy !== null, `refused via exec: ${name}`);
  // THREE shapes, because a refusal has one shape per REASON, not one per
  // boundary. Measured on node v24.17.0: a denied SELECT or INSERT says
  // `not authorized`; a denied SQLITE_READ says
  // `access to <table>.<column> is prohibited`; and this module's own
  // transaction-shape and method gates say `not permitted`. A pattern matching
  // only one of the three fails against a CORRECT implementation, and the
  // natural response to that is to loosen the authorizer until the text changes.
  check(/not authorized|is prohibited|not permitted/i.test(why ?? ""),
    `  and says why: ${name}`, String(why));
}

// Control: the SAME statements succeed on an ordinary hub connection, so the
// refusals above are the guest wrapper and not a broken database.
{
  const owner = openHub(p);
  let ok = true; try { owner.prepare("SELECT * FROM task"); } catch { ok = false; }
  check(ok, "control: an ordinary hub connection reads task normally");
  owner.close();
}

// The guest waits for the write lock like every other hub connection. On
// SQLite's default of zero it fails instantly with SQLITE_BUSY the moment a
// builder or a restore holds the lock for an instant -- and the guardian treats
// a scheduler exception as fail-open, so routine contention would dispatch
// unscheduled and defeat the quota this connection exists to enforce.
{
  // PRAGMA is denied to a guest by design, so the timeout cannot be read back
  // through this connection. It is asserted through BEHAVIOUR instead, which is
  // the property that matters anyway: a competing writer holds the lock and the
  // guest WAITS rather than failing at once.
  const holder = openHub(p);
  holder.exec("BEGIN IMMEDIATE");
  const started = Date.now();
  let why = null;
  try { openHubAsGuest(p).exec("BEGIN IMMEDIATE"); } catch (e) { why = e.message; }
  const waited = Date.now() - started;
  try { holder.exec("ROLLBACK"); } catch {}
  holder.close();
  check(why !== null && waited >= 50,
    "the guest WAITS for a contended write lock rather than failing instantly",
    JSON.stringify({ waitedMs: waited, why: String(why).slice(0, 60) }));
}

g.close();
rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
