// The dependency edge, on the SECOND attempt.
//
// `enqueue` returns null when the idempotency key is already held. That is correct
// and is what makes a double enqueue impossible -- but it leaves a producer of
// dependent effects with nothing to attach children to on any re-run: a crash
// between ticks, a retry, a tick that runs again before delivery.
//
// The dangerous repair is silent. A child enqueued with no `depends_on` is not held
// back, so it drains immediately, and its `${dep.…}` token has no parent to read
// from. `resolveDependencyArgs` refuses rather than posting a comment naming an
// issue that does not exist -- so nothing visibly breaks and the spill simply never
// happens. Every assertion here is about the second attempt, because the first one
// was already correct and is not where this fails.
import { open, tx, enqueue, outboxIdFor, enqueueWithDependants } from "../src/db/ops.mjs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};
const fresh = () => open(join(mkdtempSync(join(tmpdir(), "edge-")), "s.db"));

const parent = { idemKey: "spill:1:issue", kind: "gh.issue.create",
                 args: { nwo: "o/r", title: "t", body: "b" } };
const child = n => ({ idemKey: `spill:1:comment:${n}`, kind: "gh.pr.comment",
                      args: { nwo: "o/r", pr: 1, body: "see #${dep.number}" } });

// --- the lookup itself -----------------------------------------------------------
{
  const db = fresh();
  const id = tx(db, () => enqueue(db, parent));
  check(typeof id === "number", "control: the first enqueue returns a real id", String(id));
  check(tx(db, () => enqueue(db, parent)) === null,
    "control: a second enqueue of the same key returns null, which is why the id is lost");
  check(outboxIdFor(db, parent.idemKey) === id,
    "the id is recoverable from the key after the row already exists");
  check(outboxIdFor(db, "spill:1:nothing") === null,
    "and an unknown key is null rather than a throw or a wrong row");
}

// --- the edge is rebuilt on a re-run, not skipped and not orphaned ----------------
{
  const db = fresh();
  const first = tx(db, () => enqueueWithDependants(db, parent, [child(1), child(2)]));
  check(first.childIds.every(i => typeof i === "number"),
    "control: the first attempt enqueues both children", JSON.stringify(first));

  // THE RE-RUN. Same keys, so the parent inserts nothing and every child is already
  // held: what matters is that the rows still carry the edge.
  const again = tx(db, () => enqueueWithDependants(db, parent, [child(1), child(2)]));
  check(again.parentId === first.parentId,
    "a re-run finds the SAME parent rather than losing it", `${again.parentId} vs ${first.parentId}`);

  const rows = db.prepare("SELECT idem_key, depends_on FROM outbox WHERE kind='gh.pr.comment' ORDER BY idem_key").all();
  check(rows.length === 2, "control: the re-run did not duplicate the children", String(rows.length));
  check(rows.every(r => r.depends_on === first.parentId),
    "and both children still depend on the parent after the re-run",
    JSON.stringify(rows));
  // THE NEGATIVE CONTROL. Without the lookup a producer has only enqueue's null, and
  // the natural repair is to pass it straight through as the dependency -- which is
  // the orphan. This asserts that reading really does produce it, so the fix above is
  // load-bearing rather than merely present.
  const naive = tx(db, () => enqueue(db, parent));
  check(naive === null,
    "control: the value a producer would have used as the parent id is null on a re-run",
    String(naive));
}

// --- a parent that neither inserted nor exists refuses, rather than orphaning ------
{
  const db = fresh();
  // A kind the CHECK constraint rejects: the insert throws, so there is no row and
  // no id, and enqueuing the children anyway is exactly the silent orphan.
  let err = null;
  try {
    tx(db, () => enqueueWithDependants(db, { ...parent, kind: "gh.not.a.kind" }, [child(1)]));
  } catch (e) { err = e; }
  check(err !== null, "a parent that cannot be enqueued refuses rather than orphaning its children",
    String(err?.message).slice(0, 120));
  const orphans = db.prepare("SELECT COUNT(*) n FROM outbox WHERE depends_on IS NULL AND kind='gh.pr.comment'").get().n;
  check(orphans === 0, "and no child was written with no dependency", String(orphans));
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
