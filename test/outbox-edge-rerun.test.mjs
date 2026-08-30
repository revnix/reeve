// The dependency edge, on the SECOND attempt.
//
// `enqueue` returns null when the idempotency key is already held. That is correct
// and is what makes a double enqueue impossible -- but it leaves a producer of
// dependent effects with nothing to attach children to on any re-run: a crash
// between ticks, a retry, a tick that runs again before delivery.
//
// The dangerous repair is silent. A child enqueued with no `depends_on` is not held
// back, so it drains immediately, and its `${dep.…}` token has no parent to read
// from. `resolveDependencyArgs` then refuses it -- correctly, since the alternative
// is referencing an identifier nobody created -- but a refusal is not a failure
// anybody sees. Nothing goes red and the two-step effect never happens, which is
// the worst shape a durable queue can take: its entire promise is that a crash
// does not lose the work.
//
// Every assertion here is about the SECOND attempt. The first one was already
// correct and is not where this fails, so a fixture that only ever enqueues once
// cannot exhibit the defect no matter what it asserts.
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

// --- the children carry the edge, which is what a re-run must rebuild -----------
{
  // The refusal branch in enqueueWithDependants is deliberately NOT asserted here.
  // Its fixture used a kind the CHECK constraint rejects, so the insert threw before
  // the branch was reached and the test passed on SQLite's refusal rather than on the
  // guard's -- the sweep reported NOT_CAUGHT, which is how I found out. The branch is
  // unreachable by construction and says so in the source.
  const db = fresh();
  const { parentId } = tx(db, () => enqueueWithDependants(db, parent, [child(1)]));
  const row = db.prepare("SELECT depends_on FROM outbox WHERE kind='gh.pr.comment'").get();
  check(row.depends_on === parentId,
    "a child is written with the parent's id, not with no dependency at all",
    JSON.stringify(row));
}

console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
