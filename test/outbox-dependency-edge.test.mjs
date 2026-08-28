// The dependency edge: one effect that cannot be delivered until another has been.
//
// Spilling needs an issue created and then replies naming its number. The number
// does not exist until the create has delivered, but `idem_key` is fixed at
// enqueue time -- that is what makes a double enqueue impossible -- so the number
// cannot be part of the child's args when the child is written.
//
// Hence an edge plus a token: the child is enqueued with `${dep.…}` where the
// value goes, held back until its parent is `done`, and filled in at delivery.
//
// The failure this suite is really guarding is the QUIET one. A child that is
// never leased and never fails looks exactly like an idle queue; a token that
// resolves to nothing and gets posted anyway puts "see #" on a real pull request.
// Both are asserted directly, and both are stubbed back out below.
import { open, tx, enqueue, leaseOutbox, settleOutbox, supersedeEffects,
         cascadeDeadLetter, blockedOnDependency } from "../src/db/ops.mjs";
import { drainOutbox } from "../src/outbox/drain.mjs";
import { resolveDependencyArgs, needsDependency, DependencyResolutionError } from "../src/outbox/depends.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};
const threw = fn => { try { fn(); return null; } catch (e) { return e; } };

const fresh = tag => open(join(mkdtempSync(join(tmpdir(), `reeve-dep-${tag}-`)), "state.db"));

// --- the substitution itself, with no database and no network ------------------
{
  const args = { nwo: "o/r", pr: 7, body: "moved to #${dep.number}" };

  // CONTROL, and it has to come first: if `needsDependency` answered yes to
  // everything, every assertion below would still pass while the mechanism did
  // nothing. A value with no token must come back byte-identical.
  const plain = { nwo: "o/r", pr: 7, body: "nothing to fill" };
  check(needsDependency(args) === true, "a token is detected", JSON.stringify(args));
  check(needsDependency(plain) === false, "control: args with no token are not treated as dependent", JSON.stringify(plain));
  check(resolveDependencyArgs(plain, null) === plain,
    "control: args with no token pass through untouched, even with no parent result");

  const filled = resolveDependencyArgs(args, { number: 412, url: "https://x/412" });
  check(filled.body === "moved to #412", "a token is filled from the parent's result", filled.body);
  check(args.body === "moved to #${dep.number}", "and the ORIGINAL args are not mutated", args.body);

  // Nested and repeated, because a spill's replies are a list.
  const many = resolveDependencyArgs(
    { items: [{ body: "a #${dep.number}" }, { body: "b #${dep.number}" }], top: "${dep.url}" },
    { number: 9, url: "u" });
  check(many.items[0].body === "a #9" && many.items[1].body === "b #9" && many.top === "u",
    "every token in a nested structure is filled", JSON.stringify(many));

  // Dotted paths, so a handler may record a nested result.
  check(resolveDependencyArgs({ b: "${dep.issue.number}" }, { issue: { number: 3 } }).b === "3",
    "a dotted path reaches into the result");
}

// --- an unresolvable token must NEVER be delivered -----------------------------
{
  // This is the assertion the whole design turns on. Substituting an empty string
  // and posting is the one outcome with no honest reading: it looks delivered and
  // reads broken, on somebody's pull request, and reeve cannot take it back.
  const e1 = threw(() => resolveDependencyArgs({ b: "see #${dep.number}" }, { url: "u" }));
  check(e1 instanceof DependencyResolutionError, "a missing field throws", String(e1));
  check(/number/.test(String(e1?.message)), "and the error NAMES the path that was missing", String(e1?.message));

  const e2 = threw(() => resolveDependencyArgs({ b: "see #${dep.number}" }, { number: null }));
  check(e2 instanceof DependencyResolutionError,
    "an explicit null is missing, not the string \"null\"", String(e2));

  const e3 = threw(() => resolveDependencyArgs({ b: "see #${dep.number}" }, null));
  check(e3 instanceof DependencyResolutionError, "a token with no parent at all throws", String(e3));
  check(/no dependency/.test(String(e3?.message)),
    "and says the edge is missing rather than blaming the result's shape", String(e3?.message));
}

// --- the edge is refused when it names nothing ---------------------------------
{
  const db = fresh("enq");
  const parent = tx(db, () => enqueue(db, { idemKey: "p", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "x" } }));
  check(Number.isInteger(parent), "control: a parent enqueues and returns an id", String(parent));

  const e = threw(() => tx(db, () => enqueue(db, {
    idemKey: "orphan", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "y" }, dependsOn: 99999 })));
  check(e && /names no outbox row/.test(String(e.message)),
    "an edge naming a row that does not exist is REFUSED at enqueue", String(e?.message));
  // Foreign keys are off by default in SQLite, so without the explicit check this
  // insert succeeds and produces a row that waits for ever.
  check(db.prepare("SELECT count(*) n FROM outbox WHERE idem_key='orphan'").get().n === 0,
    "and nothing was written", "");

  const child = tx(db, () => enqueue(db, {
    idemKey: "c", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "z" }, dependsOn: parent }));
  check(db.prepare("SELECT depends_on FROM outbox WHERE id=?").get(child).depends_on === parent,
    "a valid edge is stored");
}

// --- a child is not leasable until its parent is done --------------------------
{
  const db = fresh("lease");
  const mk = (key, dependsOn = null) => tx(db, () => enqueue(db, {
    idemKey: key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: key }, dependsOn }));
  const parent = mk("parent");
  const child = mk("child", parent);

  const first = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  check(first?.id === parent, "the parent leases first", JSON.stringify(first?.id));

  // The child is the ONLY pending row left, so a lease that returns nothing is
  // the mechanism working rather than an empty queue.
  const held = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  check(held === undefined, "the child is NOT leased while its parent is inflight", JSON.stringify(held));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(child).status === "pending",
    "and it is still pending rather than skipped or failed");
  check(db.prepare("SELECT attempts FROM outbox WHERE id=?").get(child).attempts === 0,
    "and it has been charged no attempt for waiting");

  check(blockedOnDependency(db).some(r => r.id === child),
    "a waiting child is REPORTED, so it cannot be mistaken for an idle queue");

  settleOutbox(db, { id: parent, leaseToken: first.lease_token, ok: true, result: { number: 77 } });
  const now = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  check(now?.id === child, "and it becomes leasable the moment the parent is done", JSON.stringify(now?.id));
  check(now?.depends_on === parent, "the lease carries the edge back to the drainer", JSON.stringify(now?.depends_on));
  check(blockedOnDependency(db).length === 0, "and it is no longer reported as waiting");
}

// --- a parent that dies takes its children with it -----------------------------
{
  const db = fresh("cascade");
  const mk = (key, dependsOn = null) => tx(db, () => enqueue(db, {
    idemKey: key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: key }, dependsOn }));
  const a = mk("a"), b = mk("b", a), c = mk("c", b);

  // CONTROL: nothing cascades while the parent is merely unfinished. Without this
  // the assertion below would pass for a function that dead-letters everything.
  check(cascadeDeadLetter(db).length === 0, "control: a healthy pending parent cascades nothing");
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(b).status === "pending",
    "control: and its child is untouched");

  const lease = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  settleOutbox(db, { id: a, leaseToken: lease.lease_token, ok: false, retryable: false, error: "no" });
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(a).status === "dead_letter",
    "control: the parent really did dead-letter");

  const cascaded = cascadeDeadLetter(db);
  check(cascaded.length === 2, "a chain of two descendants collapses in ONE call", JSON.stringify(cascaded.map(r => r.id)));
  for (const [name, id] of [["child", b], ["grandchild", c]]) {
    const row = db.prepare("SELECT status, last_error FROM outbox WHERE id=?").get(id);
    check(row.status === "dead_letter", `the ${name} is dead-lettered rather than left pending`, row.status);
    check(/depends on/.test(row.last_error ?? ""), `and says why, naming the effect it waited for`, row.last_error);
  }
}

// --- end to end: the parent's result reaches the child's delivery --------------
{
  const db = fresh("e2e");
  const parent = tx(db, () => enqueue(db, {
    idemKey: "create", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "the issue" } }));
  tx(db, () => enqueue(db, {
    idemKey: "reply", kind: "gh.pr.comment",
    args: { nwo: "o/r", pr: 1, body: "moved to #${dep.number}" }, dependsOn: parent }));

  const delivered = [];
  const handlers = {
    "gh.pr.comment": args => {
      delivered.push(args.body);
      // The first delivery records the number the second one needs.
      return { ok: true, result: args.body === "the issue" ? { number: 412 } : {} };
    },
  };
  await drainOutbox({ db, handlers, api: () => ({ ok: true, out: "" }), max: 5, budgetMs: 600_000 });

  check(delivered.length === 2, "both effects delivered in one pass", JSON.stringify(delivered));
  check(delivered[0] === "the issue", "the parent went first", delivered[0]);
  check(delivered[1] === "moved to #412",
    "and the child was delivered with the parent's result substituted in", delivered[1]);
  check(!delivered.some(b => b.includes("${dep.")),
    "no delivery carried an unresolved token", JSON.stringify(delivered));
}

// --- a token that cannot resolve is dead-lettered, and NOT delivered -----------
{
  const db = fresh("unresolvable");
  const parent = tx(db, () => enqueue(db, {
    idemKey: "create", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "the issue" } }));
  tx(db, () => enqueue(db, {
    idemKey: "reply", kind: "gh.pr.comment",
    args: { nwo: "o/r", pr: 1, body: "moved to #${dep.number}" }, dependsOn: parent }));

  const delivered = [];
  // The parent succeeds but records a result with no `number` -- a producer and a
  // handler disagreeing about shape, which is the realistic way this breaks.
  const handlers = { "gh.pr.comment": args => { delivered.push(args.body); return { ok: true, result: { url: "u" } }; } };
  await drainOutbox({ db, handlers, api: () => ({ ok: true, out: "" }), max: 5, budgetMs: 600_000 });

  check(delivered.length === 1 && delivered[0] === "the issue",
    "the child was NOT delivered", JSON.stringify(delivered));
  const row = db.prepare("SELECT status, last_error, attempts FROM outbox WHERE idem_key='reply'").get();
  check(row.status === "dead_letter",
    "it is dead-lettered, not retried against a result that will never change", row.status);
  check(/number/.test(row.last_error ?? ""), "and the error names the missing field", row.last_error);

  // The whole point: a broken body must not reach GitHub even once.
  check(!delivered.some(b => b.includes("#undefined") || b.includes("${dep.") || b === "moved to #"),
    "and no half-substituted body was ever handed to a handler", JSON.stringify(delivered));
}

// --- a row with NO edge is not touched by any of this --------------------------
{
  // The claim this change makes is that it is inert until something enqueues a
  // dependent effect. That claim was FALSE in the first revision: every leased row
  // went through resolution, so an ordinary body quoting a token -- a review
  // trigger with an example in it, a finding quoting this module -- had no parent,
  // raised "no dependency", and was terminally dead-lettered. A change that alters
  // existing deliveries is not inert.
  const db = fresh("inert");
  tx(db, () => enqueue(db, { idemKey: "literal", kind: "gh.pr.comment",
    args: { nwo: "o/r", pr: 1, body: "write it as ${dep.number} in the example" } }));

  const delivered = [];
  const handlers = { "gh.pr.comment": args => { delivered.push(args.body); return { ok: true, result: {} }; } };
  await drainOutbox({ db, handlers, api: () => ({ ok: true, out: "" }), max: 5, budgetMs: 600_000 });

  check(delivered.length === 1, "a row with no edge is still delivered", JSON.stringify(delivered));
  check(delivered[0] === "write it as ${dep.number} in the example",
    "and its literal token text reaches the handler untouched", delivered[0]);
  check(db.prepare("SELECT status FROM outbox WHERE idem_key='literal'").get().status === "done",
    "and it is done, not dead-lettered");
}

// --- an object cannot be interpolated into text --------------------------------
{
  // `String({})` is "[object Object]" and `String([1,2])` is "1,2". Both deliver
  // without complaint, which is the visibly-broken comment this module exists to
  // refuse arriving through the one path that was not checking it.
  for (const [what, v] of [["an object", { number: 3 }], ["an array", [1, 2]]]) {
    const e = threw(() => resolveDependencyArgs({ b: "see #${dep.issue}" }, { issue: v }));
    check(e instanceof DependencyResolutionError, `${what} is refused, not stringified`, String(e));
    check(!/object Object|^1,2$/.test(String(e?.message ?? "")) && /cannot be interpolated/.test(String(e?.message)),
      `and the error says why rather than showing the mangled value`, String(e?.message));
  }
  // CONTROL: the scalar inside it still resolves, so the guard rejects the shape
  // rather than the path.
  check(resolveDependencyArgs({ b: "see #${dep.issue.number}" }, { issue: { number: 3 } }).b === "see #3",
    "control: naming a scalar inside the object still works");
}

// --- a cascaded dead letter reaches the event trail ----------------------------
{
  const db = fresh("cascade-event");
  const mk = (key, dependsOn = null) => tx(db, () => enqueue(db, {
    idemKey: key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: key }, dependsOn }));
  const a = mk("a"); const b = mk("b", a);
  const lease = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  settleOutbox(db, { id: a, leaseToken: lease.lease_token, ok: false, retryable: false, error: "no" });

  const before = db.prepare("SELECT count(*) n FROM event WHERE op='outbox.dead_letter'").get().n;
  cascadeDeadLetter(db);
  const after = db.prepare("SELECT count(*) n FROM event WHERE op='outbox.dead_letter'").get().n;
  check(after === before + 1,
    "a cascaded dead letter emits the SAME event a settled one does", `${before} -> ${after}`);
  const ev = db.prepare(`SELECT payload FROM event WHERE op='outbox.dead_letter' ORDER BY seq DESC LIMIT 1`).get();
  check(String(ev.payload).includes(String(b)), "and the event names the row that died", String(ev.payload).slice(0, 160));
  check(/cascadedFrom/.test(String(ev.payload)), "and records that it died because its parent did", String(ev.payload).slice(0, 160));
}

// --- superseding a parent must not be blocked by its own child -----------------
{
  // The foreign key is ENFORCED -- schema.sql sets PRAGMA foreign_keys = ON and
  // open() executes it -- so deleting a row another still points at throws and
  // rolls the whole reconciliation back. Reconciliation runs every tick, so that
  // is not one lost cleanup but a tick that fails on the same rows for ever.
  const db = fresh("supersede");
  const mk = (key, dependsOn = null) => tx(db, () => enqueue(db, {
    idemKey: key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: key }, dependsOn }));

  const p1 = mk("o/r#1:create"); mk("o/r#1:reply", p1);
  const e = threw(() => tx(db, () => supersedeEffects(db, { prefix: "o/r#1:", keep: new Set() })));
  check(e === null, "superseding a parent with a live dependent does not throw", String(e));
  check(db.prepare("SELECT count(*) n FROM outbox").get().n === 0,
    "and the dependent is retired with it, since its work is now meaningless");

  // A dependent the caller still WANTS blocks the retirement instead of being
  // destroyed. Deleting it would throw; deleting the parent anyway would strand it.
  const p2 = mk("o/r#2:create"); mk("o/r#2:reply", p2);
  const kept = new Set(["o/r#2:reply"]);
  let n2 = null;
  const e2 = threw(() => { n2 = tx(db, () => supersedeEffects(db, { prefix: "o/r#2:", keep: kept })); });
  check(e2 === null, "a spared dependent does not make reconciliation throw either", String(e2));
  // The count is asserted HERE and not in the inflight block below, because there
  // both rows are already inflight, so candidates and retirements are both zero
  // and the two readings cannot be told apart. A stub returning `rows.length`
  // passed that assertion -- a test that could not fail. Here the parent IS a
  // candidate and is NOT retired, so the numbers genuinely differ.
  check(n2 === 0, "and the count reports what was RETIRED (0), not what was considered (1)", String(n2));
  check(db.prepare("SELECT count(*) n FROM outbox WHERE idem_key='o/r#2:create'").get().n === 1,
    "the parent is LEFT QUEUED rather than deleted out from under a wanted child");
  check(db.prepare("SELECT count(*) n FROM outbox WHERE idem_key='o/r#2:reply'").get().n === 1,
    "and the wanted child still exists");
  check(db.prepare("SELECT count(*) n FROM event WHERE op='outbox.supersede_deferred'").get().n === 1,
    "and the deferral is recorded rather than being silent");

  // A drainer mid-delivery on a dependent blocks it for the same reason inflight
  // rows have always been excluded.
  // Its OWN store. The block above deliberately LEAVES a deferred parent pending,
  // so leasing here took that one instead -- which the control caught, and which is
  // exactly what a control is for.
  const db3 = fresh("supersede-inflight");
  const mk3 = (key, dependsOn = null) => tx(db3, () => enqueue(db3, {
    idemKey: key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: key }, dependsOn }));
  const p3 = mk3("o/r#3:create"); mk3("o/r#3:reply", p3);
  const l3 = leaseOutbox(db3, { worker: "t", kinds: ["gh.pr.comment"] });
  check(l3?.idem_key === "o/r#3:create", "control: the parent is what got leased", String(l3?.idem_key));
  db3.exec(`UPDATE outbox SET status='inflight' WHERE idem_key='o/r#3:reply'`);
  const n3 = tx(db3, () => supersedeEffects(db3, { prefix: "o/r#3:", keep: new Set() }));
  check(db3.prepare("SELECT count(*) n FROM outbox WHERE idem_key='o/r#3:create'").get().n === 1,
    "an inflight dependent defers the family rather than deleting under a drainer");
  check(n3 === 0, "and the count reports what was RETIRED, not what was considered", String(n3));
}

// --- a cascaded transition and its event commit together, or not at all --------
{
  // Emitting the event was necessary and was not sufficient. The update and the
  // insert were separate autocommit statements, so a failure between them left a
  // dead-lettered row with no immutable event -- the exact projection/trail
  // divergence the event was added to close.
  //
  // Driven by making the INSERT fail for real, with a trigger that aborts it,
  // rather than by reading the code and agreeing with it.
  const db = fresh("atomic");
  const mk = (key, dependsOn = null) => tx(db, () => enqueue(db, {
    idemKey: key, kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: key }, dependsOn }));
  const a1 = mk("a"); const b1 = mk("b", a1);
  const l = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  settleOutbox(db, { id: a1, leaseToken: l.lease_token, ok: false, retryable: false, error: "no" });

  db.exec(`CREATE TRIGGER no_cascade_events BEFORE INSERT ON event
           WHEN NEW.op = 'outbox.dead_letter'
           BEGIN SELECT RAISE(ABORT, 'event insert refused'); END`);

  const e = threw(() => cascadeDeadLetter(db));
  check(e !== null, "control: the trigger really did make the event insert fail", String(e).slice(0, 80));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(b1).status === "pending",
    "the status change is ROLLED BACK when its event cannot be written", 
    db.prepare("SELECT status FROM outbox WHERE id=?").get(b1).status);

  db.exec("DROP TRIGGER no_cascade_events");
  cascadeDeadLetter(db);
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(b1).status === "dead_letter",
    "and it goes through once the event can be written");

  // Opening its own transaction per batch means it must not be handed one.
  const e2 = threw(() => tx(db, () => cascadeDeadLetter(db)));
  check(e2 && /must not be called inside one/.test(String(e2.message)),
    "and being called inside a transaction is refused rather than nested", String(e2?.message));
}

// --- the cascade is bounded by the pass budget ---------------------------------
{
  // The drainer awaits this before it leases anything, and the daemon's tick
  // awaits the drainer. So an unbounded cascade over a large dependent tree does
  // not merely finish late, it delays evaluation, heartbeats and alerts.
  const db = fresh("bounded");
  const parent = tx(db, () => enqueue(db, {
    idemKey: "p", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "p" } }));
  for (let i = 0; i < 5; i++)
    tx(db, () => enqueue(db, { idemKey: `c${i}`, kind: "gh.pr.comment",
      args: { nwo: "o/r", pr: 1, body: `c${i}` }, dependsOn: parent }));
  const l = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  settleOutbox(db, { id: parent, leaseToken: l.lease_token, ok: false, retryable: false, error: "no" });

  // A deadline already in the past: the budget is spent deciding not to start.
  const none = cascadeDeadLetter(db, { deadlineAt: 1000, now: () => 5000 });
  check(none.length === 0, "a spent budget cascades nothing", String(none.length));
  check(db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get().n === 5,
    "and every descendant is left pending for the next pass, not lost");

  // One batch at a time, with the clock running out after the first.
  let t = 0;
  const some = cascadeDeadLetter(db, { batch: 2, deadlineAt: 10, now: () => (t += 10) - 10 });
  check(some.length === 2, "a batch is completed and the rest deferred", String(some.length));
  check(db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get().n === 3,
    "the remainder is still pending");

  // And the next pass finishes the job, because the selection is idempotent.
  const rest = cascadeDeadLetter(db);
  check(rest.length === 3, "the next pass picks up exactly what was left", String(rest.length));
  check(db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get().n === 0,
    "and nothing is stranded");
  // SIX, not five: the parent's own terminal settle emits one too, and it is the
  // same op because it is the same transition. Asserting five would have been
  // asserting that the parent's death went unrecorded.
  check(db.prepare("SELECT count(*) n FROM event WHERE op='outbox.dead_letter'").get().n === 6,
    "with one event per transition — five cascaded plus the parent's own",
    String(db.prepare("SELECT count(*) n FROM event WHERE op='outbox.dead_letter'").get().n));
}

// --- and the DRAINER actually hands its deadline down --------------------------
{
  // A correct bound that nothing is plugged into is the failure to look for. The
  // budget check inside the cascade can be perfect while the drainer calls it
  // without a deadline, and every test of the mechanism still passes.
  const db = fresh("wired");
  const parent = tx(db, () => enqueue(db, {
    idemKey: "p", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "p" } }));
  for (let i = 0; i < 5; i++)
    tx(db, () => enqueue(db, { idemKey: `c${i}`, kind: "gh.pr.comment",
      args: { nwo: "o/r", pr: 1, body: `c${i}` }, dependsOn: parent }));
  const l = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  settleOutbox(db, { id: parent, leaseToken: l.lease_token, ok: false, retryable: false, error: "no" });
  check(db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get().n === 5,
    "control: five descendants are pending under a dead parent");

  // A clock that has already run past the pass deadline by the time the cascade
  // is reached. If the drainer passes its deadline down, nothing cascades.
  let t = 0;
  await drainOutbox({ db, handlers: { "gh.pr.comment": () => ({ ok: true, result: {} }) },
                      api: () => ({ ok: true, out: "" }), max: 1, budgetMs: 1,
                      now: () => (t += 1000) });
  check(db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get().n === 5,
    "the drainer's own deadline reaches the cascade, so a spent pass cascades nothing",
    String(db.prepare("SELECT count(*) n FROM outbox WHERE status='pending'").get().n));
}

// --- a resolution failure charges no delivery it never made --------------------
{
  const db = fresh("refund");
  const parent = tx(db, () => enqueue(db, {
    idemKey: "create", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "the issue" } }));
  tx(db, () => enqueue(db, { idemKey: "reply", kind: "gh.pr.comment",
    args: { nwo: "o/r", pr: 1, body: "moved to #${dep.number}" }, dependsOn: parent }));

  const handlers = { "gh.pr.comment": () => ({ ok: true, result: { url: "u" } }) };
  await drainOutbox({ db, handlers, api: () => ({ ok: true, out: "" }), max: 5, budgetMs: 600_000 });

  const row = db.prepare("SELECT status, attempts, lease_token FROM outbox WHERE idem_key='reply'").get();
  check(row.status === "dead_letter", "control: the child really was dead-lettered", row.status);
  check(row.attempts === 0,
    "and no delivery attempt is charged, because the handler was never invoked", String(row.attempts));
  check(row.lease_token >= 1,
    "while the FENCE stays bumped, because the lease really did happen", String(row.lease_token));
}

// --- an already-transitioned row is not cascaded or announced twice -----------
{
  // What this DOES assert: the selection only ever picks rows that are still
  // pending, so a row another pass already moved is neither reported as cascaded
  // nor given a second event.
  //
  // What it does NOT assert, said plainly rather than implied: the `changes === 1`
  // test inside the transaction. Reaching that needs a second writer to move the
  // row between the select and the update, and the select now happens INSIDE the
  // write transaction precisely so no writer can. It is unreachable by
  // construction, and an assertion that appeared to cover it would be passing for
  // another reason -- which is what the first version of this block did, and a
  // stub of the guard left it green.
  const db = fresh("dup");
  const parent = tx(db, () => enqueue(db, {
    idemKey: "p", kind: "gh.pr.comment", args: { nwo: "o/r", pr: 1, body: "p" } }));
  const child = tx(db, () => enqueue(db, { idemKey: "c", kind: "gh.pr.comment",
    args: { nwo: "o/r", pr: 1, body: "c" }, dependsOn: parent }));
  const l = leaseOutbox(db, { worker: "t", kinds: ["gh.pr.comment"] });
  settleOutbox(db, { id: parent, leaseToken: l.lease_token, ok: false, retryable: false, error: "no" });

  const first = cascadeDeadLetter(db);
  check(first.length === 1, "control: the first pass cascades the child", String(first.length));
  const afterFirst = db.prepare("SELECT count(*) n FROM event WHERE op='outbox.dead_letter'").get().n;
  check(afterFirst >= 1, "control: events are being written at all", String(afterFirst));

  const again = cascadeDeadLetter(db);
  const afterSecond = db.prepare("SELECT count(*) n FROM event WHERE op='outbox.dead_letter'").get().n;
  check(again.length === 0, "a second pass does not report the same row as cascaded again", String(again.length));
  check(afterSecond === afterFirst, "and writes no second event for one transition", `${afterFirst} -> ${afterSecond}`);
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(child).status === "dead_letter",
    "control: and the row really is in the terminal state throughout");
}

// --- a store whose outbox PREDATES the column must still open ------------------
{
  // Built rather than mocked, because the defect this guards is invisible to a
  // fresh database and every other database in this suite is fresh.
  //
  // `open()` executes schema.sql BEFORE adding columns. On an existing table
  // CREATE TABLE IF NOT EXISTS does nothing, so an index in schema.sql naming a
  // not-yet-added column throws -- on exactly the stores that hold real history.
  // It was found by opening a copy of the live store AFTER this suite was green,
  // which is the only reason it is not still in the branch.
  const dir = mkdtempSync(join(tmpdir(), "reeve-dep-old-"));
  const path = join(dir, "old.db");
  const raw = new DatabaseSync(path);
  raw.exec(`CREATE TABLE outbox (
              id INTEGER PRIMARY KEY,
              idem_key TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL,
              run_id TEXT,
              args TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              attempts INTEGER NOT NULL DEFAULT 0,
              max_attempts INTEGER NOT NULL DEFAULT 8,
              not_before INTEGER NOT NULL DEFAULT 0,
              lease_expires_at INTEGER NOT NULL DEFAULT 0,
              result TEXT, last_error TEXT,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT`);
  raw.exec(`INSERT INTO outbox(idem_key,kind,args,created_at,updated_at)
            VALUES('legacy','gh.pr.comment','{}',0,0)`);
  const before = raw.prepare("SELECT count(*) n FROM pragma_table_info('outbox') WHERE name='depends_on'").get().n;
  raw.close();
  // CONTROL: the tree really is the old shape, and really does hold a row. A
  // fixture that already had the column would pass this block without testing it.
  check(before === 0, "control: the fixture's outbox genuinely lacks the column", String(before));

  const e = threw(() => {
    const db = open(path);
    const cols = db.prepare("SELECT name FROM pragma_table_info('outbox')").all().map(c => c.name);
    check(cols.includes("depends_on"), "the column is added to a table that predates it");
    check(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='index' AND name='outbox_depends'").get().n === 1,
      "and its index is created AFTER the column, not before");
    check(db.prepare("SELECT count(*) n FROM outbox").get().n === 1, "and the existing row survives");
    check(db.prepare("SELECT depends_on FROM outbox WHERE idem_key='legacy'").get().depends_on === null,
      "with null meaning what it should: this row waited for nothing");
    open(path);   // reopening must be idempotent, since every daemon start does it
  });
  check(e === null, "opening a store whose outbox predates the column does not throw", String(e));
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
