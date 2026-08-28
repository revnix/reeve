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
import { open, tx, enqueue, leaseOutbox, settleOutbox,
         cascadeDeadLetter, blockedOnDependency } from "../src/db/ops.mjs";
import { drainOutbox } from "../src/outbox/drain.mjs";
import { resolveDependencyArgs, needsDependency, DependencyResolutionError } from "../src/outbox/depends.mjs";
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

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
