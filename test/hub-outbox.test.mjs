// The outbox is what stops one crash from becoming two pull requests, and what
// stops a stale attempt from acting under a contract nobody approved.
//
// Three rules, and each has its own way of being wrong:
//   1. Keys are unique over LIVE rows only, so a re-enqueue after a hold is
//      ADMITTED and settled inert by its reconciler against external truth. A
//      blanket UNIQUE either swallows it or refuses the enqueue.
//   2. Round-keyed and sha-keyed kinds ALSO consult done rows, because for
//      those the key itself is proof the effect happened -- a rerun re-derives
//      different bytes and would otherwise push a second time for one round.
//   3. Every row carries a fence, revalidated inside the lease transaction.
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { DatabaseSync } from "node:sqlite";
import { enqueueEffect, leaseEffect, settleEffect, recoverEffects,
         voidPending, KEY_KINDS } from "../src/build/outbox.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { fail++; if (detail !== undefined) console.log(`        ${detail}`); }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-outbox-"));

// Every capability on, so a block that is not ABOUT capabilities is not gated by
// one. The capability block below turns them off one at a time.
const allOn = {
  "builder.capabilities.observe": true,
  "builder.capabilities.draftSpec": true,
  "builder.capabilities.implementLocal": true,
  "builder.capabilities.publishPr": true,
  "builder.capabilities.mergeBuilderPr": true,
};

// A task, plus a RUN of phase_event rows for its fences to reference.
// `outbox.fence` is `NOT NULL REFERENCES phase_event(seq)`, so an enqueue with
// no events to point at fails on the foreign key rather than on anything this
// suite is about.
const seed = (db, { id, phase, generation = 1, events = 12 }) => {
  db.prepare(
    `INSERT INTO task(id, project, repo_id, nwo_snapshot, title, phase, generation,
                      source_kind, source_key, repo_path, profile_path, profile_hash,
                      default_branch, visibility, registry_version, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),unixepoch())`)
    .run(id, "p", 1, "o/r", "t", phase, generation, "founder", `k:${id}`,
         "/repo", "/profile.json", "hash", "main", "private", 1);
  for (let i = 0; i < events; i++)
    db.prepare(
      `INSERT INTO phase_event(task, at, op, from_phase, to_phase, from_generation, to_generation, detail)
       VALUES(?, unixepoch(), 'phase.advanced', ?, ?, ?, ?, '{}')`)
      .run(id, phase, phase, generation, generation);
};

// A fixed clock for every lease in this file, declared ABOVE the first block
// that reads it. `leaseEffect` evaluates `not_before <= now` and the module has
// no clock of its own, so a call that omits `now` either binds undefined and
// leases nothing or forces an undeclared fallback. Position is load-bearing, not
// tidiness: a top-level `const` is in the temporal dead zone until its own line
// runs, so one declared below the blocks that read it throws on the first lease.
const NOW = 1_800_000_000;


// ── fence revalidation ───────────────────────────────────────────────────────
{
  const db = openHub(join(dir, "o1.db")); seed(db, { id: "bt:1", phase: "SPEC_DRAFT", generation: 3 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g3:SPEC_DRAFT:comment:0", kind: "gh.pr.comment",
    taskId: "bt:1", generation: 3, fence: 1, args: {} }));

  const good = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  check(good?.kind === "gh.pr.comment", "an effect whose fence still validates is leased", JSON.stringify(good));
  settleEffect(db, { id: good.id, worker: good.worker, leaseToken: good.lease_token, ok: true, result: {} });

  // now the task is redesigned out from under a second effect
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g3:SPEC_DRAFT:comment:1", kind: "gh.pr.comment",
    taskId: "bt:1", generation: 3, fence: 2, args: {} }));
  db.exec("UPDATE task SET generation=4 WHERE id='bt:1'");
  const stale = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  check(stale === null, "an effect enqueued under generation 3 is not leased once the task is in generation 4");
  check(db.prepare("SELECT status FROM outbox WHERE idempotency_key='bt:1:g3:SPEC_DRAFT:comment:1'").get().status === "fenced",
    "it settles 'fenced', with nothing performed");

  // control: an effect at the CURRENT generation is still leasable, so the
  // fence is a comparison and not a switch that turned everything off.
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g4:SPEC_DRAFT:comment:0", kind: "gh.pr.comment",
    taskId: "bt:1", generation: 4, fence: 3, args: {} }));
  check(leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW })?.task_generation === 4,
    "control: an effect at the current generation is leased normally");
  db.close();
}

// ── live-rows-only uniqueness, which is what makes resume work ───────────────
{
  const db = openHub(join(dir, "o2.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const K = "bt:1:g1:IMPLEMENTING:comment:0";
  const a = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  check(a.status === "pending", "the first enqueue is live");
  const b = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  check(b.status === "duplicate" && b.id === a.id, "a second enqueue while the first is live is inert", JSON.stringify(b));

  voidPending(db, "bt:1");
  const c = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 9, args: {} }));
  check(c.status === "pending" && c.id !== a.id,
    "after a hold voided it, the SAME key is admitted as a new row beside the voided one", JSON.stringify(c));
  db.close();
}

// ── round-keyed kinds consult done rows too ──────────────────────────────────
{
  const db = openHub(join(dir, "o3.db")); seed(db, { id: "bt:1", phase: "SPEC_DRAFT", generation: 1 });
  const K = "bt:1:g1:r0:SPEC_DRAFT:push:2";                       // round-keyed
  const a = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "git.push.branch", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  // LEASED first. `enqueueEffect` returns `{ id, status }` -- it has no `worker`
  // and no `lease_token`, so passing its result to a lease-fenced `settleEffect`
  // sends two undefineds and a conforming CAS refuses. The row stays inflight,
  // the next enqueue sees a live duplicate rather than a completed one, and the
  // round-key assertion fails before it tests anything about round keys.
  const aLease = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  settleEffect(db, { id: aLease.id, worker: aLease.worker, leaseToken: aLease.lease_token,
                     ok: true, result: { sha: "deadbeef" } });

  const b = hubTx(db, () => enqueueEffect(db, { idempotencyKey: K, kind: "git.push.branch", taskId: "bt:1", generation: 1, fence: 5, args: {} }));
  check(b.status === "superseded",
    "re-enqueuing a round-keyed push whose row is already done is settled superseded, not performed", JSON.stringify(b));
  check(db.prepare("SELECT count(*) c FROM outbox WHERE idempotency_key=? AND status='pending'").get(K).c === 0,
    "so a crash-rerun that re-derived different bytes does not become a SECOND push for the same round");

  // control: a COMMENT with a done row IS re-enqueued, because for that kind
  // the reconciler decides against external truth rather than the key.
  const C = "bt:1:g1:SPEC_DRAFT:comment:0";
  const c1 = hubTx(db, () => enqueueEffect(db, { idempotencyKey: C, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const c1Lease = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  settleEffect(db, { id: c1Lease.id, worker: c1Lease.worker, leaseToken: c1Lease.lease_token,
                     ok: true, result: {} });
  const c2 = hubTx(db, () => enqueueEffect(db, { idempotencyKey: C, kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 6, args: {} }));
  check(c2.status === "pending",
    "control: a non-round-keyed kind with a done row IS re-enqueued and left to its reconciler", JSON.stringify(c2));
  db.close();
}

// ── a capability switch that is off refuses, and does not retry ──────────────
{
  const db = openHub(join(dir, "o4.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "k", kind: "git.push.branch", taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  // Two switches, two surfaces: publishPr governs project-repo effects and
  // draftSpec governs spec-repo ones (section 1.4). Testing one kind against one
  // switch cannot tell a correct gate from one that consults the same switch for
  // everything, which would leave the spec repo ungated the moment publishPr
  // turned on.
  const off = { ...allOn, "builder.capabilities.publishPr": false };
  check(leaseEffect(db, { worker: "w", capabilities: off, now: NOW }) === null, "a project-repo push is not leased with publishPr off");
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "spec", kind: "gh.pr.comment", taskId: "bt:1",
    generation: 1, fence: 1, args: { repo: "spec" } }));
  check(leaseEffect(db, { worker: "w", capabilities: { ...allOn, "builder.capabilities.draftSpec": false }, now: NOW }) === null,
    "a SPEC-repo comment is not leased with draftSpec off");
  // A refused settle is TERMINAL, so the row above is gone; enqueue a fresh one
  // under a new key or this control has nothing to lease and fails against a
  // correct implementation.
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "spec2", kind: "gh.pr.comment", taskId: "bt:1",
    generation: 1, fence: 1, args: { repo: "spec" } }));
  check(leaseEffect(db, { worker: "w", capabilities: off, now: NOW })?.kind === "gh.pr.comment",
    "control: a spec effect IS leased when only publishPr is off, so the two switches are distinct");
  const row = db.prepare("SELECT * FROM outbox WHERE idempotency_key='k'").get();
  check(row.status === "refused", "it settles 'refused'", row.status);
  check(row.attempts === 0, "and burns no attempt: a switch the founder set is configuration, not a fault", String(row.attempts));
  check(db.prepare("SELECT count(*) c FROM escalation").get().c === 0, "and raises no escalation");
  db.close();
}

// ── duplicate delivery of every kind produces one effect ─────────────────────
// The rule this drill has to obey, and got wrong once: **the test may not do the
// deduplicating.** An earlier version expired every lease, then handed
// recoverEffects a `reconcile` callback that both performed the action and
// suppressed the repeat out of a Set the test owned. The suppression was
// therefore the test's, not the outbox's, and a hub that handed the same effect
// out twice still passed.
//
// So the consumer here has NO memory. `drain` performs whatever leaseEffect
// gives it, exactly as an executor would, and `world` is external truth --
// append-only, written only by the act of performing. Every assertion is about
// what the hub chose to hand out.
{
  const db = openHub(join(dir, "o5.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  // Every kind the DDL's CHECK admits, derived from it rather than retyped --
  // `gate.clean_notice` was missing, and it is the one whose double delivery
  // matters most: its settle writes the notice_receipt row that STARTS the
  // founder silence window, so delivering it twice restarts the clock.
  const KINDS = ["git.push.branch","gh.pr.create","gh.pr.comment","gh.pr.close","gh.pr.body",
                 "gh.review.request","gh.pr.merge","notify","gate.clean_notice",
                 "ledger.claim","ledger.release"];
  // The list must be the DDL's whole enumeration, read from the schema rather
  // than counted by hand -- a drill claiming to cover "every kind" while quietly
  // covering ten of eleven is the shape that let gate.clean_notice slip.
  const declared = [...db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='outbox'").get().sql
      .match(/kind\s+TEXT\s+NOT NULL CHECK \(kind IN\s*\(([^)]*)\)/s)[1]
      .matchAll(/'([a-z._]+)'/g)].map(m => m[1]);
  check(declared.length === KINDS.length && declared.every(k => KINDS.includes(k)),
    "control: KINDS is the outbox DDL's whole kind enumeration, not a subset",
    JSON.stringify(declared.filter(k => !KINDS.includes(k))));
  const world = [];                       // what really happened out there
  // RECONCILE BEFORE ACTUATE, in the executable definition rather than in a
  // comment further down. Appending every leased key unconditionally performs a
  // re-enqueued effect a SECOND time -- which is the duplicate delivery this
  // whole drill exists to rule out, committed by the drill's own executor.
  const drain = () => {
    for (let row; (row = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW })); ) {
      // External truth FIRST. Only an UNOBSERVED effect is performed.
      if (world.includes(row.idempotency_key)) {
        settleEffect(db, { id: row.id, worker: row.worker, leaseToken: row.lease_token,
                           ok: true, result: { reconciled: true } });
        continue;
      }
      world.push(row.idempotency_key);    // the external action
      settleEffect(db, { id: row.id, worker: row.worker, leaseToken: row.lease_token,
                         ok: true, result: {} });
    }
  };

  // The two mechanisms are DIFFERENT, and a single loop expecting `superseded`
  // for all ten contradicted this file's own control forty lines above, which
  // requires a completed `gh.pr.comment` with the same key to be re-enqueued as
  // `pending` for its reconciler. No implementation can satisfy both.
  //
  //   KEYED kinds (round- and sha-keyed): the key itself is proof the effect
  //   happened, so a re-enqueue against a `done` row is SUPERSEDED at enqueue.
  //   Everything else: the re-enqueue is ADMITTED and made inert by the
  //   reconciler against external truth.
  //
  // Partitioned from the module's own KEY_KINDS rather than a list retyped
  // here, so the test cannot disagree with the implementation about which is
  // which.
  // Assert the EXACT set first, from section 3.2, before using it to partition.
  // Deriving the expectation from KEY_KINDS makes the test adapt to whatever the
  // module exports: swap `gh.pr.merge` out and an unrelated kind in, and both
  // partitions stay non-empty and every loop below follows the mistake. The
  // design says push and merge kinds are sha-keyed and spec pushes are
  // round-keyed; that is the claim, so that is what is checked.
  check(JSON.stringify([...KEY_KINDS].sort()) === JSON.stringify(["gh.pr.merge", "git.push.branch"]),
    "KEY_KINDS is exactly the sha-/round-keyed kinds section 3.2 names",
    JSON.stringify([...KEY_KINDS].sort()));

  const keyed = KINDS.filter(k => KEY_KINDS.includes(k));
  const plain = KINDS.filter(k => !KEY_KINDS.includes(k));
  check(keyed.length > 0 && plain.length > 0,
    "control: the fixture covers both partitions, so neither branch below is vacuous",
    `keyed=${JSON.stringify(keyed)} plain=${JSON.stringify(plain)}`);

  // (a) KEYED: re-enqueue after completion is superseded, never handed out again.
  for (const k of keyed) {
    const key = `bt:1:g1:IMPLEMENTING:${k}:deadbeef`;      // sha-keyed form
    const first = hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    check(first.status === "pending", `${k}: the first enqueue is admitted`, String(first.status));
    drain();
    const repeat = hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    check(repeat.status === "superseded",
      `${k}: re-enqueueing a completed keyed effect is superseded, not admitted`, String(repeat.status));
    drain();                              // must find nothing to hand out
  }

  // (b) NON-KEYED: the re-enqueue is admitted, and the RECONCILER is what makes
  //     it inert. `drain` performs whatever it is handed, so if the second
  //     delivery reaches a worker it happens twice and `world` says so.
  for (const k of plain) {
    const key = `bt:1:g1:IMPLEMENTING:${k}:0`;
    hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    drain();                              // performs it once
    const repeat = hubTx(db, () => enqueueEffect(db, {
      idempotencyKey: key, kind: k, taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    check(repeat.status === "pending",
      `${k}: a non-keyed re-enqueue is ADMITTED, for its reconciler to settle`, String(repeat.status));
    // `drain` RECONCILES before it performs. The executor appended every leased
    // key to `world` unconditionally and had no seam to consult external truth,
    // so routing the repeat through it performed the effect a SECOND time and
    // the assertion below could never pass -- the previous fix was right about
    // the path and left the executor unable to take it.
    //
    // `drain` above is defined with that reconciler; consult-before-actuate is
    // the property this drill exists to establish, so it lives in the executor
    // and not in the assertions about it.
    //
    // THROUGH THE LEASE PATH, which is what production does with a fresh
    // pending row. Hand-editing it to an expired `inflight` and calling recovery
    // skipped the one step that matters: `leaseEffect` hands the row to a worker,
    // and nothing in the interface required the worker to reconcile before
    // acting -- so a comment, a notification, a claim or a PR creation is
    // performed a SECOND time while this drill, which exists to rule that out,
    // passes. The drill has to use the executor's own route or it is testing a
    // path production never takes.
    //
    // So the requirement is on the executor and is asserted here: a leased row
    // whose idempotency key already appears in external truth is RECONCILED, not
    // re-performed. `drain` below is that executor, and it appends to `world`
    // whenever it performs -- so a second entry is the failure, visibly.
    const before = world.filter(x => x === key).length;
    drain();
    check(world.filter(x => x === key).length === before,
      `${k}: the re-enqueued row is reconciled through the normal lease path, not performed again`,
      `${before} -> ${world.filter(x => x === key).length}`);
    // And the row still has to SETTLE, or "never performed again" is satisfied by
    // an executor that simply leaves it pending forever.
    db.exec(`UPDATE outbox SET status='inflight', lease_expires_at = unixepoch() - 1
             WHERE idempotency_key = '${key}' AND status = 'pending'`);
    await recoverEffects(db, { reconcile: (row) =>
      world.includes(row.idempotency_key)
        ? { settled: true, ok: true, result: { reconciled: true } }
        : { settled: false } });
    check(db.prepare("SELECT status FROM outbox WHERE idempotency_key=? ORDER BY id DESC LIMIT 1").get(key).status === "done",
      `${k}: and is settled from external truth without performing it again`);
  }

  const counts = {};
  for (const key of world) counts[key] = (counts[key] ?? 0) + 1;
  const repeated = Object.entries(counts).filter(([, n]) => n !== 1);
  check(world.length === KINDS.length && repeated.length === 0,
    `delivering all ${KINDS.length} kinds twice performs each exactly once`,
    `world=${world.length} repeated=${JSON.stringify(repeated)}`);

  // (b) The other half of re-delivery: a worker that performed the effect and
  //     died BEFORE settling. The row is inflight, the action has happened, and
  //     the hub does not know. Recovery must reconcile it against external truth
  //     rather than returning it to pending -- returning it to pending is what
  //     turns one crash into two pull requests.
  const crashKey = "bt:1:g1:IMPLEMENTING:crash:0";
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: crashKey, kind: "gh.pr.create",
    taskId: "bt:1", generation: 1, fence: 2, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  world.push(leased.idempotency_key);                      // the effect lands...
  // ...and the worker dies here: no settleEffect call at all.
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${leased.id}`);

  // The reconciler may only OBSERVE. It never appends to `world`; if the outbox
  // needs a second external action to make progress, this drill cannot supply one.
  let observed = 0;
  await recoverEffects(db, { reconcile: (row) => {
    observed++;
    return world.includes(row.idempotency_key)
      ? { settled: true, ok: true, result: { reconciled: true } }
      : { settled: false };
  }});
  check(observed === 1, "the crashed delivery is handed to its reconciler exactly once", String(observed));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.id).status === "done",
    "and is settled from external truth, not retried");
  drain();
  check(world.filter(k => k === crashKey).length === 1,
    "so the crashed effect happened exactly once, with no second delivery",
    `${world.filter(k => k === crashKey).length}`);
  db.close();
}

// ── settling an effect settles its drain row, through BOTH call paths ─────────
// `settleDrainFor` is the helper settleEffect AND leaseEffect must both call,
// because leaseEffect settles `fenced` and `refused` itself without going
// through settleEffect. A hook installed in only one of them leaves exactly the
// cancellations whose effect was fenced at lease time stuck in CANCELLING until
// `builder.cancel.drainMinutes` expires and the founder runs --force: the
// ordinary path becomes the exceptional one, and rows whose reconcilers did in
// fact complete are recorded as `forced`.
//
// Nothing else in this suite creates a task_drain row, so an implementation that
// omits either hook -- or both -- passed every outbox assertion above.
{
  // o6, not o5: the duplicate-delivery block above already opened o5 and seeded
  // `bt:1`, so reopening it aborted on the task primary key before either
  // settleDrainFor path ran.
  const db = openHub(join(dir, "o6.db"));
  seed(db, { id: "bt:1", phase: "CANCELLING", generation: 1 });
  // NON-CANCELLABLE effects, because those are the ones that genuinely reach a
  // drain. Entering CANCELLING runs `void-pending`, which voids every cancellable
  // pending row -- so a cancellable comment sitting leasable under a CANCELLING
  // task is a state the machine does not produce, and a cancellable effect is no
  // longer delivered once its task stops. A push mid-transport is the real case:
  // the bytes may already be on the wire, so it is `cancellable = 0`, it survives
  // the cancellation, and the drain is what waits for it.
  const drain = (id) => db.prepare(
    "INSERT INTO task_drain(task,outbox_id,recorded_at) VALUES('bt:1',?,unixepoch())").run(id);
  const settledAt = (id) => db.prepare(
    "SELECT settled_at FROM task_drain WHERE outbox_id=?").get(id).settled_at;
  const events = () => db.prepare(
    "SELECT count(*) c FROM hub_event WHERE kind='task_drain.settled'").get().c;

  // PATH 1 -- settleEffect.
  const a = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:CANCELLING:comment:0",
    kind: "git.push.branch", taskId: "bt:1", generation: 1, fence: 1, cancellable: false, args: {} }));
  drain(a.id);
  // CONTROL, and it has to come before the settle: a recorded-but-unsettled row
  // reads null. Without it an implementation that stamps settled_at at INSERT
  // satisfies both assertions below without ever calling the helper.
  check(settledAt(a.id) === null,
    "control: a recorded drain row starts unsettled", String(settledAt(a.id)));
  const before = events();
  // The LEASE's identity, not the enqueue's. `enqueueEffect` returns the row as
  // inserted, before any worker holds it, so `a.worker` and `a.lease_token` are
  // null -- and `settleEffect`'s owner/token CAS is precisely what those fields
  // have to match. Discarding the lease result left the row inflight and its
  // `task_drain` row unsettled, so both positive assertions below went red
  // against the implementation this plan prescribes.
  const leasedA = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  check(leasedA?.id === a.id,
    "fixture: the row leased is the one just enqueued, so the settle below addresses it",
    `${leasedA?.id} vs ${a.id}`);
  settleEffect(db, { id: leasedA.id, worker: leasedA.worker, leaseToken: leasedA.lease_token, ok: true, result: {} });
  check(settledAt(a.id) !== null,
    "settleEffect settles the drain row for the effect it just completed", String(settledAt(a.id)));
  check(events() === before + 1,
    "and appends exactly one task_drain.settled for it, so replay can restore the settlement",
    `${before} -> ${events()}`);

  // PATH 2 -- leaseEffect, which settles `fenced` without going through
  // settleEffect at all. This is the assertion that goes red on the
  // one-hook implementation, and it is the whole reason the helper exists.
  const b = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:CANCELLING:comment:1",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 2, args: {} }));
  drain(b.id);
  db.exec("UPDATE task SET generation=2 WHERE id='bt:1'");     // the fence no longer validates
  const mid = events();
  check(leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW }) === null,
    "fixture: the stale effect is not leased", "");
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(b.id).status === "fenced",
    "fixture: leaseEffect settled it 'fenced' without settleEffect");
  check(settledAt(b.id) !== null,
    "leaseEffect settles the drain row for an effect it fences", String(settledAt(b.id)));
  check(events() === mid + 1,
    "and appends its task_drain.settled too", `${mid} -> ${events()}`);

  // CONTROL: a drain row whose outbox row is still PENDING must stay unsettled,
  // or an implementation that settles every row on any call passes both paths
  // above and lets a task reach CANCELLED with an effect still queued to run.
  const c = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g2:CANCELLING:comment:0",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 2, fence: 3, args: {} }));
  drain(c.id);
  check(settledAt(c.id) === null,
    "control: a drain row whose effect is still pending is NOT settled", String(settledAt(c.id)));
  check(db.prepare(
    "SELECT count(*) c FROM task_drain WHERE task='bt:1' AND settled_at IS NULL").get().c === 1,
    "control: so drainRemaining still counts exactly the one outstanding effect");
  db.close();
}

// ── every outbox mutation appends its row image ──────────────────────────────
// A DELTA per path, executable. The requirement was written into the interface
// and asserted nowhere, so an implementation emitting none of these row images
// passed Task 16 -- and replay then loses an admitted effect, or restores an
// older `pending`/`inflight` status and performs an external action a second
// time. A cumulative floor would not do: it stays green when a LATER path
// appends nothing, which is exactly how five of six could be missing.
{
  const db = openHub(join(dir, "o7.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const evs = (kind, id) => db.prepare(
    `SELECT count(*) c FROM hub_event WHERE kind=? AND json_extract(payload,'$.id') = ?`).get(kind, id).c;
  // The id is DERIVED FROM THE RESULT, not passed in. An enqueue's row id does
  // not exist until the enqueue returns, and the previous form passed `null` --
  // which in SQL compares equal to nothing at all, so both counts were 0 and the
  // `before + 1` assertion failed against a correct implementation. Anything
  // keyed on a value the callback produces has to read it after the callback.
  const delta = (label, kind, fn, idOf = (out) => out.id, idHint = null) => {
    const countFor = (id) => db.prepare(
      `SELECT count(*) c FROM hub_event WHERE kind=? AND json_extract(payload,'$.id') = ?`).get(kind, id).c;
    // A DELTA per id, not an absolute count of one. Asserting the post-call
    // per-row count is exactly 1 is wrong for every path that touches a row
    // twice, and this block contains one: `leaseEffect` appends an
    // `outbox.settled` for a row and `settleEffect` appends another for the SAME
    // row, so the settle assertion observed 2 and went red against precisely the
    // implementation this plan prescribes. Only the enqueue case cannot name its
    // id before the call -- and there the pre-count is 0 by construction,
    // because the row does not exist yet.
    const idBefore = idHint === null ? null : idHint();
    const perIdBefore = idBefore === null ? 0 : countFor(idBefore);
    // Snapshot the WHOLE-kind count too, so a mutation that emits an event for
    // the wrong row is still caught: the per-id count would stay flat and look
    // like a missing event rather than a misdirected one.
    const wholeBefore = db.prepare("SELECT count(*) c FROM hub_event WHERE kind=?").get(kind).c;
    const out = fn();
    const id = idOf(out);
    const perIdAfter = countFor(id);
    check(perIdAfter === perIdBefore + 1, `${label} appends exactly one ${kind} for its own row`,
      `id=${id} ${perIdBefore} -> ${perIdAfter}`);
    check(db.prepare("SELECT count(*) c FROM hub_event WHERE kind=?").get(kind).c === wholeBefore + 1,
      `control: ${label} appends exactly one ${kind} in total, not one for another row`);
    return out;
  };

  // enqueue
  const row = delta("enqueueEffect", "outbox.enqueued", () =>
    hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:IMPLEMENTING:comment:0",
      kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} })));
  // lease -- the row becomes `inflight`, which replay must not lose. The id IS
  // knowable in advance here: it is the row the enqueue above returned.
  const leased = delta("leaseEffect", "outbox.settled",
    () => leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW }),
    (out) => out.id, () => row.id);
  // settle -- the SAME row, which by now already carries the lease's
  // `outbox.settled`. Without the hint this asserts a post-call count of one
  // against a row that correctly has two.
  delta("settleEffect", "outbox.settled",
    () => settleEffect(db, { id: leased.id, worker: leased.worker, leaseToken: leased.lease_token,
                             ok: true, result: {} }),
    () => leased.id, () => leased.id);

  // fence: a row whose generation moved settles `fenced` inside leaseEffect
  const stale = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:IMPLEMENTING:comment:1",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 2, args: {} }));
  db.exec("UPDATE task SET generation=2 WHERE id='bt:1'");
  delta("leaseEffect fencing", "outbox.fenced",
    () => leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW }),
    () => stale.id);

  // void
  const doomed = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g2:IMPLEMENTING:comment:0",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 2, fence: 3, args: {} }));
  // NOT wrapped in hubTx: `voidPending` opens its own transaction, so nesting it
  // attempts a second BEGIN IMMEDIATE and throws before a row is voided or a
  // delta measured. The live-key test above already calls it bare; these two
  // disagreed with it.
  delta("voidPending", "outbox.voided", () => voidPending(db, "bt:1"), () => doomed.id);
  // CONTROL: one per ROW voided, never one for the batch. Two pending rows, two
  // events -- an implementation appending a single batch event passes every
  // delta above, because each of those voided exactly one row.
  const v1 = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g2:IMPLEMENTING:comment:1",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 2, fence: 4, args: {} }));
  const v2 = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g2:IMPLEMENTING:comment:2",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 2, fence: 5, args: {} }));
  const beforeBatch = db.prepare("SELECT count(*) c FROM hub_event WHERE kind='outbox.voided'").get().c;
  voidPending(db, "bt:1");
  check(db.prepare("SELECT count(*) c FROM hub_event WHERE kind='outbox.voided'").get().c === beforeBatch + 2,
    "control: voidPending appends one event per ROW, not one for the batch",
    `${beforeBatch} -> ${db.prepare("SELECT count(*) c FROM hub_event WHERE kind='outbox.voided'").get().c}`);
  check(evs("outbox.voided", v1.id) === 1 && evs("outbox.voided", v2.id) === 1,
    "control: and each event names its own row");
  db.close();
}

// ── a stalled worker cannot settle the delivery that replaced it ─────────────
// The control the interface promised and no block performed. An implementation
// that CASes on `id` alone -- or on `worker` alone -- passes every other outbox
// assertion here while worker A, still running after its lease expired,
// overwrites the status and result of worker B's ACTIVE delivery.
{
  const db = openHub(join(dir, "o9.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:IMPLEMENTING:comment:0",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {} }));

  const A = leaseEffect(db, { worker: "wA", capabilities: allOn, now: NOW });
  check(A?.worker === "wA", "fixture: worker A holds the lease", JSON.stringify(A));
  // A stalls past expiry and the reconciler returns the row to pending.
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${A.id}`);
  await recoverEffects(db, { reconcile: () => ({ settled: false }) });
  const B = leaseEffect(db, { worker: "wB", capabilities: allOn, now: NOW });
  check(B?.id === A.id && B.worker === "wB",
    "fixture: the same row is re-leased to worker B", JSON.stringify(B));
  check(B.lease_token !== A.lease_token,
    "control: and the lease token CHANGED, so a token-only fence could tell them apart too",
    `${A.lease_token} -> ${B.lease_token}`);

  // A finally finishes and tries to settle. It must not.
  const stale = settleEffect(db, { id: A.id, worker: A.worker, leaseToken: A.lease_token,
                                   ok: true, result: { from: "A" } });
  check(stale?.status === "stale", "a stalled worker's settlement is refused as stale",
    JSON.stringify(stale));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(A.id).status === "inflight",
    "and B's delivery is untouched: the row is still inflight, still B's");
  // CONTROL: B settles normally, or the fence is a blanket refusal rather than
  // an owner check -- which would be worse than the race it closes.
  const ok = settleEffect(db, { id: B.id, worker: B.worker, leaseToken: B.lease_token,
                                ok: true, result: { from: "B" } });
  check(ok?.status !== "stale" && db.prepare("SELECT status FROM outbox WHERE id=?").get(B.id).status === "done",
    "control: the CURRENT owner settles normally", JSON.stringify(ok));
}

// ── not_before is honoured, at the boundary ──────────────────────────────────
// `enqueueEffect` exposed `notBefore` and nothing asserted `leaseEffect` reads
// it, so an implementation ignoring the column satisfied every fence,
// capability, uniqueness, recovery and duplicate-delivery assertion in the task
// -- while every delayed notification and every backoff retry fired at once.
{
  const db = openHub(join(dir, "o8.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const T = 1_800_000_000;
  const later = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:IMPLEMENTING:comment:0",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 1, args: {}, notBefore: T + 60 }));
  check(leaseEffect(db, { worker: "w", capabilities: allOn, now: T }) === null,
    "a row scheduled ahead is not leased before its boundary");
  check(leaseEffect(db, { worker: "w", capabilities: allOn, now: T + 59 }) === null,
    "nor one second before it");
  check(leaseEffect(db, { worker: "w", capabilities: allOn, now: T + 60 })?.id === later.id,
    "and IS leased at the boundary itself");
  // CONTROL: an unscheduled row beside it is leasable throughout, or "leases
  // nothing" satisfies both refusals above.
  const now = hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:IMPLEMENTING:comment:1",
    kind: "gh.pr.comment", taskId: "bt:1", generation: 1, fence: 2, args: {} }));
  check(leaseEffect(db, { worker: "w", capabilities: allOn, now: T })?.id === now.id,
    "control: an unscheduled row beside it is leased immediately");
  db.close();
}
// ── an ASYNC reconciler is awaited, not read as "could not tell" ────────────
// A real reconciler checks GitHub, a git remote, a receipt or ledger truth --
// all asynchronous. Its Promise is an object, so `verdict.settled` on it is
// `undefined`, and every effect was read as unobservable and returned to the
// queue. The one defence against re-performing an action that already happened
// answered "could not tell" for every async reconciler ever passed to it, and
// answered it silently.
{
  const db = openHub(join(dir, "o10.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:async", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "wA", capabilities: allOn, now: NOW });
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${leased.id}`);

  const r = await recoverEffects(db, { reconcile: async (row) => {
    await new Promise(res => setTimeout(res, 1));
    return { settled: true, ok: true, result: { pr: 11 } };
  }});
  check(r.settled === 1 && r.returned === 0,
    "an async reconciler's verdict is awaited and applied", JSON.stringify(r));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.id).status === "done",
    "so the effect is settled from external truth rather than re-queued",
    db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.id).status);
  db.close();
}

// ── the reconciler is asked while NO write transaction is held ──────────────
// It was being called inside `BEGIN IMMEDIATE`, so the hub's SOLE writer was
// held for the length of a network call and every other transition, lease and
// settle in the process queued behind an HTTP timeout. Probed rather than
// described: a second connection tries to open its own immediate transaction
// from inside the reconciler, which can only succeed if no writer is held.
{
  const db = openHub(join(dir, "o11.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:nolock", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "wA", capabilities: allOn, now: NOW });
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${leased.id}`);

  let couldWrite = null, why = null;
  await recoverEffects(db, { reconcile: () => {
    const other = new DatabaseSync(join(dir, "o11.db"));
    try { other.exec("BEGIN IMMEDIATE"); other.exec("ROLLBACK"); couldWrite = true; }
    catch (e) { couldWrite = false; why = e.message; }
    finally { other.close(); }
    return { settled: false };
  }});
  check(couldWrite === true,
    "no write transaction is held while the reconciler consults the world", String(why));

  // CONTROL: the same probe INSIDE a transaction must fail, or the probe cannot
  // tell the two situations apart and its green above means nothing.
  let inTx = null;
  hubTx(db, () => {
    const other = new DatabaseSync(join(dir, "o11.db"));
    try { other.exec("BEGIN IMMEDIATE"); other.exec("ROLLBACK"); inTx = true; }
    catch { inTx = false; }
    finally { other.close(); }
  });
  check(inTx === false, "control: the same probe inside a transaction is refused", String(inTx));
  db.close();
}

// ── an effect whose attempts are spent does not re-enter the queue ──────────
// `settleEffect` dead-letters a row whose attempts are exhausted; this path
// returned it to `pending` regardless, and `leaseEffect` does not filter
// exhausted rows. So an effect nobody could observe was leased, expired and
// requeued for ever -- performing an externally ambiguous action every round,
// which is exactly what the retry bound exists to stop.
{
  const db = openHub(join(dir, "o12.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:spent", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "wA", capabilities: allOn, now: NOW });
  db.exec(`UPDATE outbox SET attempts = max_attempts, lease_expires_at = unixepoch() - 1
           WHERE id = ${leased.id}`);

  const r = await recoverEffects(db, { reconcile: () => ({ settled: false }) });
  check(r.dead === 1 && r.returned === 0, "an exhausted unobservable effect is dead-lettered",
    JSON.stringify(r));
  const row = db.prepare("SELECT status, last_error FROM outbox WHERE id=?").get(leased.id);
  check(row.status === "dead_letter", "and its status says so", JSON.stringify(row));
  check(/attempts/.test(row.last_error ?? ""),
    "with a last_error that says why it stopped", JSON.stringify(row));
  check(leaseEffect(db, { worker: "wB", capabilities: allOn, now: NOW }) === null,
    "so nothing can lease it again");

  // CONTROL: one attempt short of the bound still returns to the queue, or
  // "stops at the limit" has become "stops".
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:short", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const two = leaseEffect(db, { worker: "wB", capabilities: allOn, now: NOW });
  db.exec(`UPDATE outbox SET attempts = max_attempts - 1, lease_expires_at = unixepoch() - 1
           WHERE id = ${two.id}`);
  const r2 = await recoverEffects(db, { reconcile: () => ({ settled: false }) });
  check(r2.returned === 1 && r2.dead === 0,
    "control: one attempt short of the bound, the effect is returned to the queue",
    JSON.stringify(r2));
  db.close();
}

// ── a verdict about a row that MOVED is not applied ─────────────────────────
// The reconciler now runs outside the write transaction, so the row can be
// re-leased, settled or voided while it is out. Applying a verdict about the
// state it was READ in would overwrite whoever holds the row now -- the same
// stale-worker failure `settleEffect` already fences, arriving by a new door.
{
  const db = openHub(join(dir, "o13.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:moved", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const A = leaseEffect(db, { worker: "wA", capabilities: allOn, now: NOW });
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${A.id}`);

  const r = await recoverEffects(db, { reconcile: () => {
    // Somebody else re-leases the row while the reconciler is out.
    db.exec(`UPDATE outbox SET worker='wB', lease_token=lease_token+1,
             lease_expires_at=unixepoch()+300 WHERE id = ${A.id}`);
    return { settled: true, ok: true, result: { pr: 99 } };
  }});
  check(r.stale === 1 && r.settled === 0,
    "a verdict about a row that has since been re-leased is dropped as stale", JSON.stringify(r));
  const row = db.prepare("SELECT status, worker, result FROM outbox WHERE id=?").get(A.id);
  check(row.status === "inflight" && row.worker === "wB",
    "and the new holder's delivery is untouched", JSON.stringify(row));
  db.close();
}

// ── FOUR expired effects in ONE pass, each taking a different outcome ───────
// Every block above hands `recoverEffects` exactly one expired row, and with one
// row none of its per-row rules can be seen to be per-row: a bound applied to
// the batch, a CAS that skips the whole loop, or a settle that writes the wrong
// id all pass a one-element fixture identically. The rules are scoped to a ROW,
// so the fixture has to contain rows that must be scored differently.
{
  const db = openHub(join(dir, "o14.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const leased = {};
  for (const k of ["a", "b", "c", "d"]) {
    hubTx(db, () => enqueueEffect(db, { idempotencyKey: `bt:1:g1:${k}`, kind: "gh.pr.comment",
                                        taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    leased[k] = leaseEffect(db, { worker: `w${k}`, capabilities: allOn, now: NOW });
  }
  check(Object.values(leased).every(Boolean) && new Set(Object.values(leased).map(r => r.id)).size === 4,
    "fixture: four distinct effects are leased", JSON.stringify(Object.values(leased).map(r => r?.id)));
  // `c` has spent its attempts; the other three have not.
  db.exec(`UPDATE outbox SET attempts = max_attempts WHERE id = ${leased.c.id}`);
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1`);

  const asked = [];
  const r = await recoverEffects(db, { reconcile: (row) => {
    const k = row.idempotency_key.split(":").pop();
    asked.push(k);
    // `d` is re-leased by somebody else while the reconciler is out, so its
    // verdict must be dropped even though the reconciler is certain about it.
    if (k === "d") {
      db.exec(`UPDATE outbox SET worker='wX', lease_token=lease_token+1,
               lease_expires_at=unixepoch()+300 WHERE id = ${leased.d.id}`);
      return { settled: true, ok: true, result: { pr: 1 } };
    }
    return k === "a" ? { settled: true, ok: true, result: { pr: 2 } } : { settled: false };
  }});

  check(asked.length === 4, "every expired row is handed to the reconciler exactly once",
    JSON.stringify(asked));
  check(r.settled === 1 && r.returned === 1 && r.dead === 1 && r.stale === 1,
    "and the four outcomes are counted separately in one pass", JSON.stringify(r));
  const status = k => db.prepare("SELECT status, worker FROM outbox WHERE id=?").get(leased[k].id);
  check(status("a").status === "done", "the observed one is settled", JSON.stringify(status("a")));
  check(status("b").status === "pending",
    "the unobservable one with attempts left is re-queued", JSON.stringify(status("b")));
  check(status("c").status === "dead_letter",
    "the exhausted one is dead-lettered, and its neighbours' attempts did not exempt it",
    JSON.stringify(status("c")));
  check(status("d").status === "inflight" && status("d").worker === "wX",
    "and the re-leased one keeps its NEW holder: a stale verdict beside three live ones is still dropped",
    JSON.stringify(status("d")));
  db.close();
}

// ── merging is gated on the MERGE switch, not on publishing ────────────────
// `builder.capabilities.mergeBuilderPr` is declared in the profile schema and
// defaults to false INDEPENDENTLY of `publishPr` -- and nothing read it. Every
// project-repository effect, `gh.pr.merge` included, was classified under
// `publishPr`, so a founder who enabled publishing enabled merging with it, and
// a merge row already pending when merge authority was withdrawn was still
// leased and delivered. A switch that governs nothing is worse than no switch:
// it is a control an operator believes they have set.
{
  const db = openHub(join(dir, "o15.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:merge", kind: "gh.pr.merge",
                                      taskId: "bt:1", generation: 1, fence: 1,
                                      args: { repo_id: 1, pr: 7 } }));
  // Publishing ON, merging OFF -- which is the DEFAULT pairing, not an exotic one.
  const publishOnly = { ...allOn, "builder.capabilities.mergeBuilderPr": false };
  const refused = leaseEffect(db, { worker: "w", capabilities: publishOnly, now: NOW });
  check(refused === null, "a merge is not leased while the merge switch is off",
    JSON.stringify(refused));
  const row = db.prepare("SELECT status, last_error FROM outbox WHERE idempotency_key='bt:1:g1:merge'").get();
  check(row.status === "refused", "it is refused as configuration rather than left pending",
    JSON.stringify(row));
  check(/mergeBuilderPr/.test(row.last_error ?? ""),
    "and it names the switch the operator actually has to turn on", JSON.stringify(row));
  db.close();
}

// CONTROL, both directions, or "merge is gated" has become "merge never runs"
// and "publishing is gated" has quietly stopped being true.
{
  const db = openHub(join(dir, "o16.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:merge2", kind: "gh.pr.merge",
                                      taskId: "bt:1", generation: 1, fence: 1,
                                      args: { repo_id: 1, pr: 8 } }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  check(leased?.kind === "gh.pr.merge",
    "control: with the merge switch on, the merge is leased", JSON.stringify(leased));
  db.close();

  const db2 = openHub(join(dir, "o17.db"));
  seed(db2, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db2, () => enqueueEffect(db2, { idempotencyKey: "bt:1:g1:comment", kind: "gh.pr.comment",
                                        taskId: "bt:1", generation: 1, fence: 1,
                                        args: { repo_id: 1, pr: 9 } }));
  // Merging ON, publishing OFF: an ordinary project-repo effect must STILL be
  // governed by publishPr, or the merge carve-out has widened past the one kind.
  const mergeOnly = { ...allOn, "builder.capabilities.publishPr": false };
  check(leaseEffect(db2, { worker: "w", capabilities: mergeOnly, now: NOW }) === null,
    "control: an ordinary project-repo effect is still governed by publishPr");
  check(/publishPr/.test(db2.prepare("SELECT last_error FROM outbox WHERE idempotency_key='bt:1:g1:comment'").get().last_error ?? ""),
    "control: and names publishPr, not the merge switch");
  db2.close();
}

// ── one reconciler failure does not stop the pass ──────────────────────────
// The reconciler consults the outside world, which is the part of this system
// most entitled to fail. A throw aborted the loop before the apply transaction,
// so verdicts already obtained were discarded and every later expired row was
// skipped -- and the scan is ORDER BY id, so one permanently malformed row at
// the front stopped the whole outbox recovering on every pass, for ever.
{
  const db = openHub(join(dir, "o18.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const leased = {};
  for (const k of ["a", "b", "c"]) {
    hubTx(db, () => enqueueEffect(db, { idempotencyKey: `bt:1:g1:${k}`, kind: "gh.pr.comment",
                                        taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    leased[k] = leaseEffect(db, { worker: `w${k}`, capabilities: allOn, now: NOW });
  }
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1`);

  // CAUGHT, because the defect this covers PROPAGATES: without per-row isolation
  // the reconciler's throw comes straight out of recoverEffects and ends the
  // file, which is a red that prints no name and takes every later block with it.
  const asked = [];
  let r = null, passThrew = null;
  try {
    r = await recoverEffects(db, { reconcile: (row) => {
      const k = row.idempotency_key.split(":").pop();
      asked.push(k);
      if (k === "a") throw new Error("the API is unreachable");
      return { settled: true, ok: true, result: { pr: 1 } };
    }});
  } catch (e) { passThrew = e; }
  check(passThrew === null, "a reconciler that throws does not abort the pass",
    String(passThrew?.message));
  r ??= { settled: -1, returned: -1 };
  check(asked.length === 3, "every expired row is still offered to the reconciler",
    JSON.stringify(asked));
  check(r.settled === 2, "the rows that COULD be observed are settled", JSON.stringify(r));
  check(r.returned === 1, "and the one that failed is returned to the queue, not lost",
    JSON.stringify(r));
  const failed = db.prepare("SELECT status, last_error FROM outbox WHERE id=?").get(leased.a.id);
  check(failed.status === "pending", "the failed row is pending, since nothing was established",
    JSON.stringify(failed));
  check(/unreachable/.test(failed.last_error ?? ""),
    "and last_error says WHY it could not be told, rather than cycling silently",
    JSON.stringify(failed));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.c.id).status === "done",
    "control: a row AFTER the failing one was still reconciled");

  // CONTROL: an async rejection is the same shape, since a real reconciler is
  // async and a rejected promise is how it actually fails.
  db.exec(`UPDATE outbox SET status='inflight', worker='wZ', lease_expires_at=unixepoch()-1
           WHERE id = ${leased.c.id}`);
  let r2 = null, rejThrew = null;
  try { r2 = await recoverEffects(db, { reconcile: async () => { throw new Error("rejected"); } }); }
  catch (e) { rejThrew = e; }
  check(rejThrew === null, "control: a rejected async reconciler does not abort the pass either",
    String(rejThrew?.message));
  check(r2?.returned === 1 && r2?.settled === 0,
    "control: a REJECTED async reconciler is handled the same way", JSON.stringify(r2));
  db.close();
}

// ── a retryable failure is SCHEDULED, not merely allowed ───────────────────
// Returning the row to `pending` without advancing `not_before` left it due
// immediately, and `leaseEffect` takes every pending row whose schedule is due
// -- so the executor leased the same failing delivery again on the very next
// iteration and burned all eight attempts in a tight burst against whatever was
// failing. The backoff was promised by the column and never written to it.
{
  const db = openHub(join(dir, "o19.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:retry", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  const before = db.prepare("SELECT not_before FROM outbox WHERE id=?").get(leased.id).not_before;

  const r = settleEffect(db, { id: leased.id, worker: "w", leaseToken: leased.lease_token,
                               ok: false, retryable: true, error: "502 from GitHub" });
  check(r.status === "pending", "a retryable failure returns to the queue", JSON.stringify(r));
  const row = db.prepare("SELECT status, not_before, attempts FROM outbox WHERE id=?").get(leased.id);
  const now = db.prepare("SELECT unixepoch() n").get().n;
  check(row.not_before > now, "and is scheduled in the FUTURE, not due immediately",
    JSON.stringify({ ...row, now }));
  check(row.not_before > before, "which is later than the schedule it had", `${before} -> ${row.not_before}`);

  // AND THE LEASE HONOURS IT. Advancing the column is only half the property:
  // the executor must actually decline the row, or the backoff is a number
  // nobody reads. The clock here is the DATABASE's, not the file's fixed `NOW`
  // -- that constant sits far in the future, so it sails past any real backoff
  // and the probe would report success without ever exercising the schedule.
  check(leaseEffect(db, { worker: "w2", capabilities: allOn, now }) === null,
    "so the executor cannot lease it again on the next pass");
  // CONTROL: at its scheduled time it IS leasable, or "backs off" has become
  // "never runs again".
  const due = leaseEffect(db, { worker: "w2", capabilities: allOn, now: row.not_before });
  check(due?.id === leased.id, "control: once the backoff elapses it is leased again",
    JSON.stringify(due));
  db.close();
}

// CONTROL: a TERMINAL settle leaves the schedule alone -- nothing will read it
// again, and moving it would be a write with no meaning.
{
  const db = openHub(join(dir, "o20.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:done", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  const before = db.prepare("SELECT not_before FROM outbox WHERE id=?").get(leased.id).not_before;
  settleEffect(db, { id: leased.id, worker: "w", leaseToken: leased.lease_token,
                     ok: true, result: { pr: 1 } });
  const row = db.prepare("SELECT status, not_before FROM outbox WHERE id=?").get(leased.id);
  check(row.status === "done" && row.not_before === before,
    "control: a successful settle does not move not_before", JSON.stringify({ before, ...row }));
  db.close();
}

// ── an ABSENT capability is off, not on ────────────────────────────────────
// Every builder capability in the profile schema defaults to FALSE, so an
// omitted entry means "off" everywhere else in the system. Here `undefined ===
// false` is false, so a partially populated map -- or the `capabilities = {}`
// this function DEFAULTS to -- authorised the effect. A real push, PR operation
// or merge performed because a key was missing from an object, and it silently
// undid the merge switch added earlier in this same branch.
{
  const db = openHub(join(dir, "o21.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const mk = (key, kind, args = {}) => hubTx(db, () => enqueueEffect(db,
    { idempotencyKey: key, kind, taskId: "bt:1", generation: 1, fence: 1, args }));

  // THE DEFAULT ARGUMENT, which is the shape a forgetful caller actually passes.
  mk("bt:1:g1:bare", "gh.pr.merge", { repo_id: 1, pr: 1 });
  check(leaseEffect(db, { worker: "w" }) === null,
    "leaseEffect with no capabilities at all leases nothing");
  const bare = db.prepare("SELECT status, last_error FROM outbox WHERE idempotency_key='bt:1:g1:bare'").get();
  check(bare.status === "refused", "the effect is refused as configuration", JSON.stringify(bare));
  check(/not set|defaults to off/.test(bare.last_error ?? ""),
    "and says the switch was never set, rather than implying it was turned off",
    JSON.stringify(bare));

  // A PARTIAL map: publishing set, merging simply absent.
  mk("bt:1:g1:partial", "gh.pr.merge", { repo_id: 1, pr: 2 });
  const partial = { "builder.capabilities.publishPr": true };
  check(leaseEffect(db, { worker: "w", capabilities: partial }) === null,
    "an absent merge switch does not authorise a merge");

  // CONTROL: explicitly true still leases, or "fail closed" has become "never run".
  mk("bt:1:g1:on", "gh.pr.merge", { repo_id: 1, pr: 3 });
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  check(leased?.idempotency_key === "bt:1:g1:on",
    "control: an explicitly enabled switch still leases", JSON.stringify(leased));
  db.close();
}

// ── an Error OBJECT is stored as its message ───────────────────────────────
// node:sqlite's behaviour here depends on ARITY, and the difference matters. A
// single object argument is read as a NAMED-parameter bag, so an Error passed
// alone binds nothing and the column takes NULL. Every statement in outbox.mjs
// binds POSITIONALLY with several arguments, and in that shape an Error is not a
// bindable type: `run` THROWS.
//
// So the failure an executor actually hits is not a lost diagnostic. It is a
// settle that throws, a transaction that rolls back, and an effect left
// `inflight` with its result discarded -- the delivery happened, the hub does not
// know, and the row waits for its lease to expire. Both shapes are asserted
// below, because a fixture that reproduced only the first would have proved the
// conversion against a failure this code cannot have.
{
  const db = openHub(join(dir, "o22.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  const mk = (k) => { hubTx(db, () => enqueueEffect(db, { idempotencyKey: k, kind: "gh.pr.comment",
      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
    return leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW }); };

  // FIXTURE FIRST, in BOTH arities, or this asserts a conversion against a
  // failure the real call site cannot produce.
  {
    const probe = new DatabaseSync(":memory:");
    probe.exec("CREATE TABLE one(a TEXT)");
    probe.exec("CREATE TABLE many(a TEXT, b TEXT, c TEXT)");
    probe.prepare("INSERT INTO one(a) VALUES(?)").run(new Error("boom"));
    check(probe.prepare("SELECT a FROM one").get().a === null,
      "fixture: a LONE Error argument is read as a named-parameter bag and binds NULL");
    let threw = null;
    try { probe.prepare("INSERT INTO many(a,b,c) VALUES(?,?,?)").run("s", null, new Error("boom")); }
    catch (e) { threw = e; }
    check(threw !== null,
      "fixture: but POSITIONALLY, among several arguments, it THROWS -- which is the shape settleEffect uses",
      String(threw?.code ?? threw?.message));
    probe.close();
  }

  const a = mk("bt:1:g1:objerr");
  settleEffect(db, { id: a.id, worker: "w", leaseToken: a.lease_token,
                     ok: false, retryable: true, error: new Error("502 from GitHub") });
  check(db.prepare("SELECT last_error FROM outbox WHERE id=?").get(a.id).last_error === "502 from GitHub",
    "an Error object settles cleanly and is stored as its message",
    JSON.stringify(db.prepare("SELECT last_error FROM outbox WHERE id=?").get(a.id)));

  // CONTROL: a plain string still arrives unchanged, so the conversion has not
  // started rewriting what callers already got right.
  const b = mk("bt:1:g1:strerr");
  settleEffect(db, { id: b.id, worker: "w", leaseToken: b.lease_token,
                     ok: false, retryable: true, error: "plain string reason" });
  check(db.prepare("SELECT last_error FROM outbox WHERE id=?").get(b.id).last_error === "plain string reason",
    "control: a string is stored unchanged");

  // CONTROL: null stays null -- a success has no error and must not acquire one.
  const c = mk("bt:1:g1:noerr");
  settleEffect(db, { id: c.id, worker: "w", leaseToken: c.lease_token, ok: true, result: { pr: 1 } });
  check(db.prepare("SELECT last_error FROM outbox WHERE id=?").get(c.id).last_error === null,
    "control: a successful settle records no error");
  db.close();
}

// ── a reconcile failure is backed off like any other retry ─────────────────
// A row returned here is due immediately, and `leaseEffect` takes every pending
// row whose schedule is due -- so an effect requeued because the external service
// was UNREACHABLE was leased again on the next pass and the externally ambiguous
// action attempted straight back at the service that just failed. settleEffect
// learned this a round earlier and this path did not: two ways out of inflight,
// one of them honouring the schedule.
{
  const db = openHub(join(dir, "o23.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:rerr", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  db.exec(`UPDATE outbox SET lease_expires_at = unixepoch() - 1 WHERE id = ${leased.id}`);

  const r = await recoverEffects(db, { reconcile: () => { throw new Error("service unreachable"); } });
  check(r.returned === 1, "the unobservable effect is returned to the queue", JSON.stringify(r));
  const row = db.prepare("SELECT status, not_before, last_error FROM outbox WHERE id=?").get(leased.id);
  const now = db.prepare("SELECT unixepoch() n").get().n;
  check(row.status === "pending", "as pending", JSON.stringify(row));
  check(row.not_before > now, "and scheduled in the FUTURE, not due immediately",
    JSON.stringify({ ...row, now }));
  check(leaseEffect(db, { worker: "w2", capabilities: allOn, now }) === null,
    "so the executor does not go straight back at the service that just failed");
  // CONTROL: at its scheduled time it IS leasable again.
  check(leaseEffect(db, { worker: "w2", capabilities: allOn, now: row.not_before })?.id === leased.id,
    "control: once the backoff elapses it is leased again");
  db.close();
}

// CONTROL: an EXHAUSTED row is dead-lettered, and its schedule is left alone --
// nothing will read it again, so moving it would be a write with no meaning.
{
  const db = openHub(join(dir, "o24.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:rspent", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  const before = db.prepare("SELECT not_before FROM outbox WHERE id=?").get(leased.id).not_before;
  db.exec(`UPDATE outbox SET attempts = max_attempts, lease_expires_at = unixepoch() - 1
           WHERE id = ${leased.id}`);
  // A RECONCILER THAT COULD NOT LOOK NEVER SPENDS THE DELIVERY BUDGET.
  // `attempts` counts POSTs, each of which could duplicate an external act; a
  // read that can only ever conclude "still cannot tell" performs no delivery.
  // Charging it makes the safe act as scarce as the dangerous one -- and
  // spending it dead-letters a row that MAY have landed and settles its drain,
  // so CANCELLED becomes reachable with a push outstanding.
  const errored = await recoverEffects(db, { reconcile: () => { throw new Error("still unreachable"); } });
  check(errored.dead === 0 && errored.returned === 1,
    "an exhausted row whose reconciler ERRORED is returned, not dead-lettered",
    JSON.stringify(errored));
  check(db.prepare("SELECT status FROM outbox WHERE id=?").get(leased.id).status === "pending",
    "so it will be asked again rather than discarded as if it never happened");

  // CONTROL: a reconciler that LOOKED and found nothing IS definitive -- the
  // effect did not happen -- so the delivery budget applies and the row dies.
  db.exec(`UPDATE outbox SET status='inflight', worker='w', lease_expires_at=unixepoch()-1
           WHERE id = ${leased.id}`);
  const looked = await recoverEffects(db, { reconcile: () => ({ settled: false }) });
  check(looked.dead === 1,
    "control: an exhausted row whose reconciler LOOKED and found nothing is dead-lettered",
    JSON.stringify(looked));
  db.close();
}

// ── a stopped task delivers nothing it could abandon ───────────────────────
// The generation fence cannot answer this. A hold, a cancellation, an
// infeasibility and a lost claim all leave the generation ALONE -- deliberately,
// because they stop the task without redefining its contract -- so an effect
// enqueued before the stop still matches the fence. `void-pending` was meant to
// cover it and marks `pending` rows only, so an effect INFLIGHT when the stop
// commits is missed: the gap was never a row nobody caught, it was a row that
// came BACK when its worker reported a retryable failure.
{
  const db = openHub(join(dir, "o25.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:stopped", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  const leased = leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW });
  check(leased != null, "fixture: the effect is inflight when the task stops", JSON.stringify(leased));

  // The hold commits, AS A TRANSITION. The phase alone is not enough: the fence
  // asks WHEN the task stopped, so that the stop's own compensations -- the
  // comment explaining the hold -- are still delivered while the work that
  // preceded it is not. A fixture that only sets the column has no such moment,
  // and the predicate correctly answers "deliverable" because nothing says
  // otherwise.
  db.exec(`UPDATE task SET phase='BLOCKED' WHERE id='bt:1'`);
  db.exec(`INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
           VALUES('bt:1',unixepoch(),'phase.held','IMPLEMENTING','BLOCKED',1,1,'{}')`);
  check(db.prepare("SELECT generation FROM task WHERE id='bt:1'").get().generation === 1,
    "fixture: and the hold did NOT bump the generation, so the fence still passes");

  const r = settleEffect(db, { id: leased.id, worker: "w", leaseToken: leased.lease_token,
                               ok: false, retryable: true, error: "502" });
  check(r.status === "fenced",
    "a retryable failure under a stopped task is fenced, not returned to the queue",
    JSON.stringify(r));
  check(leaseEffect(db, { worker: "w2", capabilities: allOn, now: NOW }) === null,
    "so nothing can lease it again and perform the act the task was stopped to prevent");

  // AND AT THE LEASE, which is the other door. A row still pending when the stop
  // commits is fenced when the executor next reaches it.
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:pending", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  check(leaseEffect(db, { worker: "w3", capabilities: allOn, now: NOW }) === null,
    "a PENDING effect for a stopped task is not leased either");
  check(db.prepare("SELECT status FROM outbox WHERE idempotency_key='bt:1:g1:pending'").get().status === "fenced",
    "it is fenced, which is terminal, so its drain settles rather than hanging");
  db.close();
}

// CONTROL, both directions.
{
  const db = openHub(join(dir, "o26.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  // 1. An ACTIVE task still delivers, or "stopped" has become "never".
  hubTx(db, () => enqueueEffect(db, { idempotencyKey: "bt:1:g1:live", kind: "gh.pr.comment",
                                      taskId: "bt:1", generation: 1, fence: 1, args: {} }));
  check(leaseEffect(db, { worker: "w", capabilities: allOn, now: NOW })?.idempotency_key === "bt:1:g1:live",
    "control: an ACTIVE task's effect is still leased");

  // 2. A NON-cancellable effect survives the stop. `cancellable = 0` means the
  // bytes may already be on the wire and abandoning it is not a compensation --
  // that is the whole reason the column exists, and the drain waits for it.
  const db2 = openHub(join(dir, "o27.db"));
  seed(db2, { id: "bt:1", phase: "CANCELLING", generation: 1 });
  hubTx(db2, () => enqueueEffect(db2, { idempotencyKey: "bt:1:g1:push", kind: "git.push.branch",
                                        taskId: "bt:1", generation: 1, fence: 1,
                                        cancellable: false, args: {} }));
  check(leaseEffect(db2, { worker: "w", capabilities: allOn, now: NOW })?.idempotency_key === "bt:1:g1:push",
    "control: a NON-cancellable effect is still delivered after the task stops");
  db.close(); db2.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
