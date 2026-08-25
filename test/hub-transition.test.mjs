// Every transition is exactly one BEGIN IMMEDIATE that CAS-updates the
// projection, appends its phase_event and hub_event, records the artifact sha
// that justified it, and enqueues side effects rather than performing them.
//
// The CAS predicate includes the GENERATION, not just the phase. Without it a
// stale attempt from generation 3 can act on a task that a --redesign moved
// into generation 4: the phase would still match, the update would succeed, and
// the task would be advanced by work done under a contract nobody approved.
import { openHub, hubTx } from "../src/build/hubdb.mjs";
import { applyTransition, applyCompensation, COMPENSATIONS } from "../src/build/transition.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { fail++; if (detail !== undefined) console.log(`        ${detail}`); }
};
const dir = mkdtempSync(join(tmpdir(), "reeve-transition-"));

// A task, plus a RUN of phase_event rows. `outbox.fence` references
// phase_event(seq), so a fixture with no events fails on the foreign key rather
// than on anything these blocks are about -- and the lost-race block measures a
// DELTA against this count rather than against zero.
// `project` is 'p' because the territory fixtures below insert leases under that
// key, and `regrant-territory`'s intersection check is scoped by project -- a
// seed using any other value makes every conflict check match nothing, so the
// live-lease block's resume succeeds and its three assertions fail for a reason
// that has nothing to do with territory.
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
// ── the ordinary case ────────────────────────────────────────────────────────
{
  const db = openHub(join(dir, "t1.db")); seed(db, { id: "bt:1", phase: "RESEARCH", generation: 2 });
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "RESEARCH", expectedGeneration: 2,
    evidence: { kind: "phase.succeeded", phase: "RESEARCH" }, artifactSha: "sha-research", op: "phase.advanced" });
  check(r.applied === true && r.to === "DESIGN", "a legal transition advances the task", JSON.stringify(r));
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "DESIGN", "and the projection moved");
  const ev = db.prepare("SELECT * FROM phase_event WHERE task='bt:1' ORDER BY seq DESC LIMIT 1").get();
  check(ev.from_phase === "RESEARCH" && ev.to_phase === "DESIGN" && ev.from_generation === 2 && ev.to_generation === 2,
    "the phase_event records both phases and both generations", JSON.stringify(ev));
  check(ev.artifact_sha === "sha-research", "and the artifact sha that justified it", String(ev.artifact_sha));
  check(r.seq === ev.seq, "and its seq is returned as the fence for this transition's effects");
  // TWO row images now: task.transitioned and phase_event.appended. The
  // assertion said one and the implementation emits both, so it contradicted the
  // plan it appears in.
  const kinds = db.prepare("SELECT kind FROM hub_event WHERE task='bt:1' ORDER BY seq").all().map(r => r.kind);
  // Order matches the implementation: phase_event.appended is emitted at the
  // insert, task.transitioned after the projection is read back. The reversed
  // expectation would have failed against correct code -- the worst kind of
  // failing test, because it argues for changing the implementation.
  check(JSON.stringify(kinds) === '["phase_event.appended","task.transitioned"]',
    "the transition appends BOTH row images in the same transaction, in emit order", kinds.join(","));
  db.close();
}

// ── the lost race is a NO-OP, not an error ───────────────────────────────────
{
  const db = openHub(join(dir, "t2.db")); seed(db, { id: "bt:1", phase: "DESIGN", generation: 2 });
  // Captured HERE, from THIS database, immediately before the stale call. `seed`
  // mints a run of phase_event rows, so the count is not zero, and reading a
  // baseline declared in another block would be both out of scope and about a
  // different file.
  const eventsBefore = db.prepare("SELECT count(*) c FROM phase_event").get().c;
  let threw = null;
  let r; try {
    r = applyTransition(db, { taskId: "bt:1", expectedPhase: "RESEARCH", expectedGeneration: 2,
      evidence: { kind: "phase.succeeded", phase: "RESEARCH" }, artifactSha: "x", op: "phase.advanced" });
  } catch (e) { threw = e.message; }
  check(threw === null, "a concurrent actor winning the race does not throw", String(threw));
  check(r?.applied === false && r.reason === "lost-race", "it is reported as a lost race", JSON.stringify(r));
  // The baseline belongs to THIS block and THIS database. It was previously read
  // from a `const` declared inside the preceding block -- out of scope here, and
  // counting a different file besides -- so the assertion below reached a
  // ReferenceError instead of checking anything.
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "DESIGN", "the projection is untouched");
  // A DELTA, not an absolute count: `seed` mints a run of phase_event rows so
  // that outbox fences have events to reference, and an assertion written as
  // `=== 0` reads those and fails against a correct implementation. Measuring
  // the change is also the right shape regardless of what the fixture seeds --
  // the claim is "this call appended nothing", not "the table is empty".
  check(db.prepare("SELECT count(*) c FROM phase_event").get().c === eventsBefore,
    "and no event is appended for work that did not happen",
    `${eventsBefore} -> ${db.prepare("SELECT count(*) c FROM phase_event").get().c}`);
  db.close();
}

// ── the generation fence ─────────────────────────────────────────────────────
// THE assertion of this task. A phase-only CAS passes every test above.
{
  const db = openHub(join(dir, "t3.db")); seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 4 });
  const stale = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 3,
    evidence: { kind: "phase.succeeded", phase: "IMPLEMENTING" }, artifactSha: "x", op: "phase.advanced" });
  check(stale.applied === false && stale.reason === "lost-race",
    "an attempt from generation 3 cannot act on a task now in generation 4", JSON.stringify(stale));
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "IMPLEMENTING", "the redesigned task did not move");

  const current = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 4,
    evidence: { kind: "phase.succeeded", phase: "IMPLEMENTING" }, artifactSha: "x", op: "phase.advanced" });
  check(current.applied === true, "control: the SAME call at generation 4 succeeds, so the predicate is the generation and not a blanket refusal");
  db.close();
}

// ── compensations on the way into a hold ─────────────────────────────────────
{
  const db = openHub(join(dir, "t4.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  // WITH a head sha. `write-pr-hold` persists `pr_hold.head_sha`, and a fixture
  // that supplies no witness anywhere -- not on impl_pr, not as an inbox row, not
  // on the evidence -- leaves a correct implementation with nothing to build the
  // asserted row from: it either violates its own NOT NULL or invents a value,
  // and the test cannot tell those apart from success. `impl_pr` is where the
  // projection keeps the PR's current head, so it is where the compensation
  // reads it, INSIDE the transaction rather than from the caller.
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,7,'${"c".repeat(40)}',unixepoch())`);
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at) VALUES('p','prefix','packages/x','bt:1',unixepoch()+120)`);
  db.exec(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
           VALUES('k1','gh.pr.comment','bt:1',1,1,1,'{}',unixepoch(),unixepoch())`);
  db.exec(`INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,cancellable,args,created_at,updated_at)
           VALUES('k2','git.push.branch','bt:1',1,1,0,'{}',unixepoch(),unixepoch())`);

  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "over_budget" }, op: "task.blocked" });
  check(r.applied && r.to === "BLOCKED", "an over-budget slice blocks", JSON.stringify(r));
  check(db.prepare("SELECT status FROM outbox WHERE idempotency_key='k1'").get().status === "voided",
    "the pending CANCELLABLE row is voided");
  check(db.prepare("SELECT status FROM outbox WHERE idempotency_key='k2'").get().status === "pending",
    "and a NON-cancellable row is left alone: voiding a push mid-transport is not a compensation");
  check(db.prepare("SELECT count(*) c FROM pr_hold WHERE task='bt:1' AND cleared_at IS NULL").get().c === 1,
    "one pr_hold row is written for the open builder PR");
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 0,
    "and the territory lease is released in the same transaction");
  check(db.prepare("SELECT held_from FROM task WHERE id='bt:1'").get().held_from === "IMPLEMENTING",
    "held_from records where resume goes back to");

  // A second hold must STACK, not transition and not write a second open hold.
  const again = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "ownership_lost" }, op: "task.blocked" });
  check(again.applied === false && again.reason === "stacked", "a hold on an already-held task stacks", JSON.stringify(again));
  check(db.prepare("SELECT count(*) c FROM pr_hold WHERE repo_id=1 AND pr=7 AND cleared_at IS NULL").get().c === 1,
    "and there is still exactly ONE open hold, so one_open_hold stays satisfiable");
  check(db.prepare("SELECT reason FROM pr_hold WHERE repo_id=1 AND pr=7 AND cleared_at IS NULL").get().reason === "ownership_lost",
    "the existing hold's reason is updated to the newest one");
  check(db.prepare("SELECT count(*) c FROM hold_reason WHERE task='bt:1' AND cleared_at IS NULL").get().c === 2,
    "and both reasons are listed, so resume can clear them all");
  check(db.prepare("SELECT held_from FROM task WHERE id='bt:1'").get().held_from === "IMPLEMENTING",
    "held_from is NOT rewritten by the second hold");
  db.close();
}

// ── resume clears every hold in one transaction ──────────────────────────────
{
  // Executable setup, not a prose comment. The block previously opened with
  // `/* seed a BLOCKED task ... */` and then used `db`, which the standard
  // harness does not supply -- so the file stopped at `ReferenceError: db is not
  // defined` before exercising any resume compensation.
  const db = openHub(join(dir, "t7.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  for (const reason of ["over_budget", "ownership_lost"])
    db.prepare(`INSERT INTO hold_reason(task,reason,at) VALUES('bt:1',?,unixepoch())`).run(reason);
  db.prepare(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at)
              VALUES('bt:1',1,7,?,'blocked_other',unixepoch())`).run("a".repeat(40));
  // `bt:1` needs a CLAIM of its own, or `regrant-territory` has nothing to
  // grant and an implementation whose regrant branch is empty passes this block
  // while the task returns to IMPLEMENTING holding no lease at all -- which
  // makes the expired `bt:0` lease beside it irrelevant to what is tested.
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned)
           VALUES('bt:1','prefix','packages/x',0)`);
  // The lease's task must EXIST -- territory_lease references task(id) and
  // openHub enables foreign keys, so a lease owned by an unseeded `bt:0` fails
  // at setup and the block never reaches regrant-territory at all.
  seed(db, { id: "bt:0", phase: "CANCELLED", generation: 1 });
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at)
           VALUES('p','prefix','packages/x','bt:0',unixepoch()-1)`);   // expired: regrant must succeed
  const resumed = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "phase.resumed" });
  check(resumed.applied, "the resume applies", JSON.stringify(resumed));
  // ASSERTED, not described. This block previously proved only that the resume
  // did not throw, so an empty `regrant-territory` branch passed it while the
  // task returned to IMPLEMENTING holding no lease at all.
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 1,
    "the resume re-granted the task's own territory",
    JSON.stringify(db.prepare("SELECT * FROM territory_lease").all()));
  db.close();
}

// ── and a LIVE overlapping lease rolls the whole resume back ─────────────────
// The other direction, and the one an unconditional `regrant-territory` fails.
// §10.2's intersection check is re-run INSIDE the transaction precisely because
// the machine's `territoryConflict` evidence is the caller's earlier read; only
// a check under BEGIN IMMEDIATE excludes a filing that landed in between.
{
  // t2b, not t2: the lost-race block above already seeded `bt:1` into t2.
  const db = openHub(join(dir, "t2b.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  seed(db, { id: "bt:2", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned) VALUES('bt:1','prefix','packages/x',0)`);
  // Another task holds it, and its lease is LIVE -- not expired, so the regrant
  // must lose rather than reap.
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at)
           VALUES('p','prefix','packages/x','bt:2',unixepoch()+3600)`);
  const blocked = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "phase.resumed" });
  check(!blocked.applied, "a resume whose territory is now held by a live task does not apply",
    JSON.stringify(blocked));
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "BLOCKED",
    "and the WHOLE transaction rolled back: the task is still BLOCKED");
  check(db.prepare("SELECT task FROM territory_lease WHERE path='packages/x'").get().task === "bt:2",
    "control: the other task still holds the lease, so the regrant did not overwrite it");
  db.close();
}

// ── a terminal transition's EXPLANATION is not a hold-reason enum ───────────
// `founder.infeasible` requires `evidence.reason` and requires it to be prose:
// a terminal state with no durable explanation cannot be explained afterwards.
// `write-pr-hold` read that same field as a member of `pr_hold.reason`'s closed
// CHECK, so an ordinary sentence threw inside `holdReasonFor` and rolled the
// whole terminal transition back. The more carefully the founder explained
// themselves, the more certainly the transition failed.
{
  const db = openHub(join(dir, "t12.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,77,'deadbee',unixepoch())`);
  const words = "the upstream dependency cannot be licensed for redistribution";
  // CAUGHT, not called bare. The defect this covers THROWS out of the whole
  // transition, so an uncaught call ends the file and takes every later block
  // with it -- a crash where the evidence should have been one named failure.
  let threw = null, r = null;
  try {
    r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
      evidence: { kind: "founder.infeasible", reason: words }, op: "phase.infeasible" });
  } catch (e) { threw = e; }
  check(threw === null, "a free-form infeasible reason does not throw out of the transition",
    String(threw?.message));
  check(r?.applied === true && r?.to === "INFEASIBLE",
    "and the terminal transition applies", JSON.stringify(r));
  const hold = db.prepare("SELECT reason, detail, head_sha FROM pr_hold WHERE task='bt:1'").get();
  check(hold?.reason === "escalated",
    "the hold's reason is derived from the transition, so it satisfies the CHECK",
    JSON.stringify(hold));
  check(hold?.detail === words,
    "and the founder's words are kept in detail rather than discarded", JSON.stringify(hold));
  check(hold?.head_sha === "deadbee",
    "with the head read from the projection inside the transaction", JSON.stringify(hold));
  db.close();
}

// CONTROL: the `hold` transition still writes its own enum member, or the
// derivation has replaced a real reason with a blanket "escalated".
{
  const db = openHub(join(dir, "t13.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,78,'cafe123',unixepoch())`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "ownership_lost" }, op: "phase.held" });
  check(r.applied === true, "control: a hold transition applies", JSON.stringify(r));
  check(db.prepare("SELECT reason FROM pr_hold WHERE task='bt:1'").get()?.reason === "ownership_lost",
    "control: and its hold carries the reason the machine validated",
    JSON.stringify(db.prepare("SELECT reason, detail FROM pr_hold WHERE task='bt:1'").get()));
  db.close();
}

// ── a task held BEFORE implementing still gets a hold ──────────────────────
// `write-pr-hold` learned to hold the spec PR, but `hasOpenBuilderPr` is the
// predicate that decides whether the machine EMITS that compensation, and it
// counted `impl_pr` alone. So the commonest pre-implementation hold -- a task
// stopped in SPEC_PR_OPEN or GATE -- emitted no hold at all and left its spec PR
// mergeable for as long as it stayed BLOCKED. The repair to the compensation was
// invisible because the gate in front of it had not moved.
{
  const db = openHub(join(dir, "t23.db"));
  seed(db, { id: "bt:1", phase: "SPEC_PR_OPEN", generation: 1 });
  db.exec(`UPDATE task SET spec_repo_id=9, spec_pr=42, spec_head='specsha' WHERE id='bt:1'`);
  check(db.prepare("SELECT count(*) c FROM impl_pr WHERE task='bt:1'").get().c === 0,
    "fixture: no implementation PR exists, which is the whole point");
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "SPEC_PR_OPEN", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "over_budget" }, op: "phase.held" });
  check(r.applied === true && r.to === "BLOCKED", "the hold applies", JSON.stringify(r));
  const hold = db.prepare("SELECT pr, repo_id, reason FROM pr_hold WHERE task='bt:1'").get();
  check(hold != null, "and the spec PR is held", JSON.stringify(hold));
  check(hold?.pr === 42 && hold?.repo_id === 9, "on the task's own spec PR", JSON.stringify(hold));
  check(hold?.reason === "over_budget",
    "carrying the reason the machine validated", JSON.stringify(hold));
  db.close();
}

// CONTROL: a task with NO spec PR and no implementation PR writes no hold, or
// the predicate has become "always true" and every hold writes a phantom row.
{
  const db = openHub(join(dir, "t24.db"));
  seed(db, { id: "bt:1", phase: "SPEC_DRAFT", generation: 1 });
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "SPEC_DRAFT", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "over_budget" }, op: "phase.held" });
  check(r.applied === true, "control: a hold with no PR at all still applies", JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM pr_hold WHERE task='bt:1'").get().c === 0,
    "control: and writes no hold, because there is nothing to hold");
  db.close();
}

// ── the pin expires ────────────────────────────────────────────────────────
// hub.sql calls `territory_lease.pinned_until` "the ONLY home of the pin", and
// `task_territory.pinned` is what the FILING asked for -- a durable bit nothing
// ever clears. Reading the bit meant `release-territory` was omitted on every
// hold of a task that was EVER pinned; and since a lease is live while its task
// is non-terminal, that expired pin then blocked every overlapping filing for
// ever rather than until its deadline. A pin is a promise with an end.
{
  const db = openHub(join(dir, "t25.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned) VALUES('bt:1','prefix','packages/x',1)`);
  // The claim is pinned; the LEASE's pin has run out.
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at,pinned_until)
           VALUES('p','prefix','packages/x','bt:1',unixepoch()+3600, unixepoch()-1)`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "over_budget" }, op: "phase.held" });
  check(r.applied === true, "a hold on a task whose pin expired applies", JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 0,
    "and the territory IS released, because the pin is over",
    JSON.stringify(db.prepare("SELECT * FROM territory_lease").all()));
  db.close();
}

// CONTROL: a LIVE pin still holds the territory across the hold, or "the pin
// expires" has become "the pin does nothing".
{
  const db = openHub(join(dir, "t26.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned) VALUES('bt:1','prefix','packages/x',1)`);
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at,pinned_until)
           VALUES('p','prefix','packages/x','bt:1',unixepoch()+3600, unixepoch()+3600)`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "hold", reason: "over_budget" }, op: "phase.held" });
  check(r.applied === true, "control: the hold applies", JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 1,
    "control: a LIVE pin keeps the territory across the hold");
  db.close();
}

// ── two PRs with the same number in different repositories ─────────────────
// A pull-request number is unique only within its repository, and the close set
// now spans two. Keys built from the task, generation and PR number alone
// collided, `enqueueEffect` returned the second as a duplicate, and the drain
// never saw it -- so the task could reach CANCELLED with one PR permanently
// open while the drain that exists to prove otherwise agreed everything settled.
{
  const db = openHub(join(dir, "t27.db"));
  seed(db, { id: "bt:1", phase: "IMPL_PR_OPEN", generation: 1 });
  db.exec(`UPDATE task SET spec_repo_id=9, spec_pr=5, spec_head='specsha' WHERE id='bt:1'`);
  // THE SAME NUMBER, in a different repository.
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,5,'implsha',unixepoch())`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPL_PR_OPEN", expectedGeneration: 1,
    evidence: { kind: "founder.cancel" }, op: "phase.cancelled" });
  check(r.applied === true, "the cancellation applies", JSON.stringify(r));
  const closes = db.prepare(
    `SELECT args FROM outbox WHERE task_id='bt:1' AND kind='gh.pr.close'`).all()
    .map(x => JSON.parse(x.args).repo_id).sort();
  check(closes.length === 2, "BOTH PRs are enqueued for closing, not one",
    JSON.stringify(closes));
  check(JSON.stringify(closes) === "[1,9]",
    "one per repository, so neither was swallowed as a duplicate", JSON.stringify(closes));
  const comments = db.prepare(
    `SELECT count(*) c FROM outbox WHERE task_id='bt:1' AND kind='gh.pr.comment'`).get().c;
  check(comments === 2, "and each gets its own explaining comment", String(comments));
  db.close();
}

// ── a depth override keeps its own hold reason ─────────────────────────────
// `depth_post_approval` is a member of pr_hold's CHECK and of HOLD_ESCALATION,
// the machine emits it, and `record-hold-reason` writes it to the task -- so
// classifying the PR's hold as the generic `escalated` made the hold and its own
// task disagree about why the work stopped, in the row a guardian reads to
// explain the block.
{
  const db = openHub(join(dir, "t28.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,3,'sha',unixepoch())`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "depth.override", depth: "deep" }, op: "phase.held" });
  check(r.applied === true, "a post-approval depth override applies", JSON.stringify(r));
  const hold = db.prepare("SELECT reason FROM pr_hold WHERE task='bt:1'").get();
  check(hold?.reason === "depth_post_approval",
    "and its hold carries the depth-specific reason, not the generic one",
    JSON.stringify(hold));
  const onTask = db.prepare("SELECT reason FROM hold_reason WHERE task='bt:1' ORDER BY id DESC LIMIT 1").get();
  check(onTask == null || onTask.reason === hold?.reason,
    "so the hold and the task agree about why the work stopped",
    JSON.stringify({ hold: hold?.reason, task: onTask?.reason }));
  db.close();
}

// ── a cap-reached task's SPEC PR gets a durable hold ───────────────────────
// `gate.capReached` happens at GATE by definition: a spec PR is open and no
// implementation PR exists yet. `write-pr-hold` iterated `impl_pr` alone, so the
// compensation ran and wrote nothing -- the task sat ESCALATED with its spec PR
// still mergeable, which is the exact outcome a fail-closed stop exists to
// prevent, defeated by the compensation meant to prevent it.
{
  const db = openHub(join(dir, "t21.db"));
  seed(db, { id: "bt:1", phase: "GATE", generation: 1 });
  db.exec(`UPDATE task SET spec_repo_id=9, spec_pr=5, spec_head='specsha' WHERE id='bt:1'`);
  check(db.prepare("SELECT count(*) c FROM impl_pr WHERE task='bt:1'").get().c === 0,
    "fixture: there is no implementation PR, which is what made this reachable");
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "GATE", expectedGeneration: 1,
    evidence: { kind: "gate.capReached" }, op: "phase.escalated" });
  check(r.applied === true && r.to === "ESCALATED", "the cap escalates the task", JSON.stringify(r));
  const hold = db.prepare("SELECT repo_id, pr, head_sha, reason FROM pr_hold WHERE task='bt:1'").get();
  check(hold != null, "and the spec PR is held", JSON.stringify(hold));
  check(hold?.pr === 5 && hold?.repo_id === 9, "on the task's own spec PR", JSON.stringify(hold));
  check(hold?.head_sha === "specsha",
    "witnessed by the spec head, which pr_hold.head_sha requires", JSON.stringify(hold));
  db.close();
}

// CONTROL: a regenerate must NOT hold the spec PR -- it re-renders the spec and
// pushes a new head to that same PR, so a hold would block the work it is
// dispatching.
{
  const db = openHub(join(dir, "t22.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`UPDATE task SET spec_repo_id=9, spec_pr=5, spec_head='specsha' WHERE id='bt:1'`);
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,11,'implsha',unixepoch())`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "founder.regenerate",
                snapshot: { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f",
                            profileHash: "h", defaultBranch: "main", visibility: "private",
                            specRepoId: 9, gateDefinitionHash: "g", registryVersion: 3,
                            founderUserId: 4242 } },
    op: "phase.regenerated" });
  check(r.applied === true, "control: the regenerate applies", JSON.stringify(r));
  const held = db.prepare("SELECT pr FROM pr_hold WHERE task='bt:1'").all().map(h => h.pr);
  check(held.includes(11), "control: it holds the implementation PR", JSON.stringify(held));
  check(!held.includes(5), "control: and NOT the spec PR it is about to push to",
    JSON.stringify(held));
  db.close();
}

// ── an abandoned task does not leave its SPEC PR open ──────────────────────
// Cancellation or infeasibility after SPEC_PR_OPEN can leave spec_repo_id and
// spec_pr set with no impl_pr row at all, so `close-prs` enqueued nothing and the
// task reached its terminal state with the spec PR still open against work that
// no longer exists.
{
  const db = openHub(join(dir, "t17.db"));
  seed(db, { id: "bt:1", phase: "SPEC_PR_OPEN", generation: 1 });
  db.exec(`UPDATE task SET spec_repo_id = 9, spec_pr = 42 WHERE id = 'bt:1'`);
  check(db.prepare("SELECT count(*) c FROM impl_pr WHERE task='bt:1'").get().c === 0,
    "fixture: there is no implementation PR, which is what made this reachable");
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "SPEC_PR_OPEN", expectedGeneration: 1,
    evidence: { kind: "founder.cancel" }, op: "phase.cancelled" });
  check(r.applied === true, "the cancellation applies", JSON.stringify(r));
  const closes = db.prepare(
    "SELECT idempotency_key, args FROM outbox WHERE task_id='bt:1' AND kind='gh.pr.close'").all();
  check(closes.length === 1, "the spec PR is enqueued for closing", JSON.stringify(closes));
  check(JSON.parse(closes[0]?.args ?? "{}").pr === 42,
    "and it is the task's own spec PR", closes[0]?.args);
  check(db.prepare("SELECT count(*) c FROM outbox WHERE task_id='bt:1' AND kind='gh.pr.comment'").get().c === 1,
    "with the comment that explains it");
  db.close();
}

// CONTROL: a REDESIGN must leave the spec PR alone. hub.sql is explicit that the
// spec PR is fixed for the task's life and a redesign pushes a NEW HEAD to it,
// so closing it there would destroy the thread the redesign is continuing.
{
  const db = openHub(join(dir, "t18.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING', spec_repo_id=9, spec_pr=42 WHERE id='bt:1'`);
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,7,'sha',unixepoch())`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: true }, op: "phase.resumed" });
  check(r.applied === true, "control: the redesign resume applies", JSON.stringify(r));
  const prs = db.prepare(
    "SELECT args FROM outbox WHERE task_id='bt:1' AND kind='gh.pr.close'").all()
    .map(r => JSON.parse(r.args).pr);
  check(!prs.includes(42), "control: a redesign does NOT close the spec PR", JSON.stringify(prs));
  check(prs.includes(7), "control: it still closes the implementation PR", JSON.stringify(prs));
  db.close();
}

// ── a superseded effect stops blocking DONE ────────────────────────────────
// `voided` was the only status a later success could forgive. A `refused` row is
// what a capability being OFF looks like, and turning it back on re-enqueues the
// effect -- so the replacement reached `done` while the original was counted for
// ever, and finalize.settled could never move the task to DONE. A task
// permanently unable to finish because a switch had once been off.
{
  const db = openHub(join(dir, "t19.db"));
  seed(db, { id: "bt:1", phase: "FINALIZING", generation: 1 });
  const seq = db.prepare(
    `INSERT INTO phase_event(task, at, op, from_phase, to_phase, from_generation, to_generation, detail)
     VALUES('bt:1', unixepoch(), 'phase.advanced', 'SLICE_MERGED', 'FINALIZING', 1, 1, '{}')
     RETURNING seq`).get().seq;
  const mk = (key, status) => db.prepare(
    `INSERT INTO outbox(idempotency_key, kind, task_id, task_generation, fence, cancellable, args,
                        status, attempts, max_attempts, not_before, lease_expires_at, lease_token,
                        created_at, updated_at)
     VALUES(?, 'gh.pr.comment', 'bt:1', 1, ?, 1, '{}', ?, 1, 8, 0, 0, 0, unixepoch(), unixepoch())
     RETURNING id`).get(key, seq, status).id;

  for (const st of ["refused", "failed", "dead_letter"]) {
    const key = `bt:1:g1:${st}`;
    mk(key, st);
    const blocked = applyTransition(db, { taskId: "bt:1", expectedPhase: "FINALIZING", expectedGeneration: 1,
      evidence: { kind: "finalize.settled", outstanding: 0 }, op: "phase.finalized" });
    check(blocked.applied === false && /not complete/.test(blocked.refusal ?? ""),
      `an unreplaced ${st} effect still blocks DONE`, JSON.stringify(blocked));
    // The replacement, enqueued AFTER it and settled.
    mk(key, "done");
  }
  const done = applyTransition(db, { taskId: "bt:1", expectedPhase: "FINALIZING", expectedGeneration: 1,
    evidence: { kind: "finalize.settled", outstanding: 0 }, op: "phase.finalized" });
  check(done.applied === true && done.to === "DONE",
    "once each is replaced by a LATER done on the same key, the task finalizes",
    JSON.stringify(done));
  db.close();
}

// CONTROL: a done row that PREDATES the unhappy one forgives nothing, or
// "replacement" has stopped meaning "afterwards".
{
  const db = openHub(join(dir, "t20.db"));
  seed(db, { id: "bt:1", phase: "FINALIZING", generation: 1 });
  const seq = db.prepare(
    `INSERT INTO phase_event(task, at, op, from_phase, to_phase, from_generation, to_generation, detail)
     VALUES('bt:1', unixepoch(), 'phase.advanced', 'SLICE_MERGED', 'FINALIZING', 1, 1, '{}')
     RETURNING seq`).get().seq;
  const mk = (key, status) => db.prepare(
    `INSERT INTO outbox(idempotency_key, kind, task_id, task_generation, fence, cancellable, args,
                        status, attempts, max_attempts, not_before, lease_expires_at, lease_token,
                        created_at, updated_at)
     VALUES(?, 'gh.pr.comment', 'bt:1', 1, ?, 1, '{}', ?, 1, 8, 0, 0, 0, unixepoch(), unixepoch())`)
    .run(key, seq, status);
  mk("bt:1:g1:hist", "done");        // the history
  mk("bt:1:g1:hist", "refused");     // and the later refusal
  const blocked = applyTransition(db, { taskId: "bt:1", expectedPhase: "FINALIZING", expectedGeneration: 1,
    evidence: { kind: "finalize.settled", outstanding: 0 }, op: "phase.finalized" });
  check(blocked.applied === false,
    "control: an EARLIER done does not forgive a later refusal", JSON.stringify(blocked));
  db.close();
}

// ── TWO open PRs, so the per-PR scope is visible ────────────────────────────
// `write-pr-hold` loops over a task's open PRs and upserts on the OPEN row for
// each. Every fixture for it seeds one `impl_pr`, and with one PR a hold keyed on
// the task, on the repository, or on nothing at all behaves identically: the
// second write is what reveals which key the upsert is actually using. A
// one-element fixture cannot show whether a scope is right.
{
  const db = openHub(join(dir, "t14.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,101,'sha-a',unixepoch()),
                 ('bt:1',1,1,1,102,'sha-b',unixepoch())`);
  const words = "the vendor withdrew the API we were building against";
  let threw = null, r = null;
  try {
    r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
      evidence: { kind: "founder.infeasible", reason: words }, op: "phase.infeasible" });
  } catch (e) { threw = e; }
  check(threw === null && r?.applied === true, "the terminal transition applies with two open PRs",
    String(threw?.message ?? JSON.stringify(r)));
  const holds = db.prepare("SELECT pr, reason, detail, head_sha FROM pr_hold WHERE task='bt:1' ORDER BY pr").all();
  check(holds.length === 2, "BOTH open PRs are held, not just the last one written",
    JSON.stringify(holds));
  check(holds.every(h => h.reason === "escalated" && h.detail === words),
    "each carries the derived reason and the founder's words", JSON.stringify(holds));
  check(holds[0]?.head_sha === "sha-a" && holds[1]?.head_sha === "sha-b",
    "and each witnesses its OWN head, so the second did not overwrite the first",
    JSON.stringify(holds));
  db.close();
}

// ── THREE claims, one of which conflicts ────────────────────────────────────
// `regrant-territory` loops over a task's claims and grants each. With one claim
// the loop is not a loop, so nothing shows that a conflict found on the third
// claim undoes the first two -- and a partial grant is the worst outcome
// available here: a task resumes holding some of its territory and believes it
// holds all of it.
{
  const db = openHub(join(dir, "t15.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  seed(db, { id: "bt:2", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned)
           VALUES('bt:1','prefix','packages/a',0),
                 ('bt:1','prefix','packages/b',0),
                 ('bt:1','prefix','packages/c',0)`);
  // The conflict is on the LAST claim, so the first two are granted before it is
  // reached. Only the transaction rolling back can remove them.
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at)
           VALUES('p','file','packages/c/x.ts','bt:2',unixepoch()+3600)`);
  const blocked = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "phase.resumed" });
  check(!blocked.applied, "a conflict on the third claim refuses the whole resume",
    JSON.stringify(blocked));
  check(db.prepare("SELECT count(*) c FROM territory_lease WHERE task='bt:1'").get().c === 0,
    "and NO claim is left granted: the first two rolled back with it",
    JSON.stringify(db.prepare("SELECT * FROM territory_lease").all()));
  db.close();
}

// CONTROL: three claims with nothing in the way are ALL granted, or "refuses on
// conflict" has become "grants at most the first".
{
  const db = openHub(join(dir, "t16.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned)
           VALUES('bt:1','prefix','packages/a',0),
                 ('bt:1','prefix','packages/b',1),
                 ('bt:1','file','packages/c/x.ts',0)`);
  const ok = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "phase.resumed" });
  check(ok.applied === true, "control: an unobstructed resume applies", JSON.stringify(ok));
  const rows = db.prepare("SELECT kind, path, pinned_until FROM territory_lease WHERE task='bt:1' ORDER BY path").all();
  check(rows.length === 3, "control: all three claims are granted", JSON.stringify(rows));
  check(rows[0].pinned_until === null && rows[1].pinned_until !== null && rows[2].pinned_until === null,
    "control: and the pin lands on the pinned claim ONLY, not on the batch",
    JSON.stringify(rows));
  db.close();
}

// ── the resume runs ADMISSION'S scan, not an exact-path lookup ──────────────
// A held task resuming while another task holds a live lease on an ancestor, a
// descendant, or the same path under the other claim kind found no row on the
// exact `(project, kind, path)` key. The regrant then inserted under a DIFFERENT
// primary key and succeeded, so both tasks resumed holding paths `overlaps()`
// calls mutually exclusive -- the one outcome the whole territory model exists
// to prevent, reached by the check being narrower than the predicate.
{
  const db = openHub(join(dir, "t2c.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  seed(db, { id: "bt:2", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned) VALUES('bt:1','prefix','packages/x',0)`);
  // A DESCENDANT, filed under the OTHER kind: same bytes, different primary key.
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at)
           VALUES('p','file','packages/x/a.ts','bt:2',unixepoch()+3600)`);
  const blocked = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "phase.resumed" });
  check(!blocked.applied, "a resume overlapping a live lease by ancestry is refused",
    JSON.stringify(blocked));
  check(/packages\/x\/a\.ts/.test(JSON.stringify(blocked)),
    "and the refusal names the lease it actually overlaps", JSON.stringify(blocked));
  check(db.prepare("SELECT count(*) c FROM territory_lease").get().c === 1,
    "no second lease was granted over the same bytes",
    JSON.stringify(db.prepare("SELECT * FROM territory_lease").all()));
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "BLOCKED",
    "and the whole transaction rolled back");
  db.close();
}

// CONTROL: a live lease in the same project that does NOT overlap must still let
// the resume through, or the scan has become "refuse whenever anything is held".
{
  const db = openHub(join(dir, "t2d.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  seed(db, { id: "bt:2", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned) VALUES('bt:1','prefix','packages/x',0)`);
  db.exec(`INSERT INTO territory_lease(project,kind,path,task,expires_at)
           VALUES('p','prefix','packages/y','bt:2',unixepoch()+3600)`);
  const ok = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "phase.resumed" });
  check(ok.applied === true, "control: a non-overlapping live lease does not block the resume",
    JSON.stringify(ok));
  check(db.prepare("SELECT task FROM territory_lease WHERE path='packages/x'").get()?.task === "bt:1",
    "control: and the resuming task got its own lease",
    JSON.stringify(db.prepare("SELECT * FROM territory_lease").all()));
  db.close();
}

// ── a plain resume clears every hold it entered with ─────────────────────────
// Its OWN fixture. The previous version ran this against the database that had
// just proved `bt:2` holds a LIVE overlapping lease, and then expected the same
// resume to succeed without expiring or deleting that lease -- so it demanded
// two opposite answers from one authoritative check. It also asserted on
// `hold_reason` and `pr_hold` rows that block never seeded.
{
  const db = openHub(join(dir, "t4b.db"));
  seed(db, { id: "bt:1", phase: "BLOCKED", generation: 1 });
  db.exec(`UPDATE task SET held_from='IMPLEMENTING' WHERE id='bt:1'`);
  db.exec(`INSERT INTO task_territory(task,kind,path,pinned) VALUES('bt:1','prefix','packages/x',0)`);
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,7,'${"c".repeat(40)}',unixepoch())`);
  db.exec(`INSERT INTO pr_hold(task,repo_id,pr,head_sha,reason,created_at)
           VALUES('bt:1',1,7,'${"c".repeat(40)}','over_budget',unixepoch())`);
  for (const reason of ["over_budget", "harness_touched"])
    db.exec(`INSERT INTO hold_reason(task,reason,at) VALUES('bt:1','${reason}',unixepoch())`);
  check(db.prepare("SELECT count(*) c FROM hold_reason WHERE cleared_at IS NULL").get().c === 2,
    "fixture: the task is BLOCKED with two open hold reasons and one open pr_hold");

  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "BLOCKED", expectedGeneration: 1,
    evidence: { kind: "founder.resume", redesign: false }, op: "task.resumed" });
  check(r.applied && r.to === "IMPLEMENTING" && r.generation === 1,
    "a plain resume re-enters held_from with the generation unchanged", JSON.stringify(r));
  check(db.prepare("SELECT count(*) c FROM pr_hold WHERE cleared_at IS NULL").get().c === 0, "and clears the pr_hold");
  check(db.prepare("SELECT count(*) c FROM hold_reason WHERE cleared_at IS NULL").get().c === 0, "and every stacked reason");
  check(db.prepare("SELECT resume_seq FROM task WHERE id='bt:1'").get().resume_seq === 1,
    "and increments resume_seq, so a re-minted spec round gets a distinct idempotency key");
  db.close();
}

// ── the force-cancel drain window, either side of the boundary ───────────────
// The clock and the threshold arrive through the interface: this module has no
// clock, and the hub does not store the profile. Both boundaries are exercised,
// because a comparison written `>` instead of `>=` passes any test that only
// probes one side of it.
{
  const db = openHub(join(dir, "t5.db"));
  seed(db, { id: "bt:1", phase: "CANCELLING", generation: 1 });
  const ENTERED = 1_800_000_000, MINUTES = 30;
  db.prepare(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,detail)
              VALUES(100,'bt:1',?,'task.cancelling','IMPLEMENTING','CANCELLING','{}')`).run(ENTERED);
  const force = (now) => applyTransition(db, { taskId: "bt:1", expectedPhase: "CANCELLING", expectedGeneration: 1,
    evidence: { kind: "founder.cancelForce", drainEligible: true }, op: "task.cancelled",
    now, drainMinutes: MINUTES });

  const early = force(ENTERED + MINUTES * 60 - 1);
  check(early.applied === false && /29m of its 30m/.test(early.refusal ?? ""),
    "one second short of the window, --force is refused and says how far in it is", JSON.stringify(early));
  const onTime = force(ENTERED + MINUTES * 60);
  check(onTime.applied === true && onTime.to === "CANCELLED",
    "and exactly at the window it is allowed: the boundary is inclusive", JSON.stringify(onTime));

  // A caller that supplies no threshold is refused rather than defaulted. An
  // invented window is the one thing this guard exists to prevent.
  const db2 = openHub(join(dir, "t6.db"));
  seed(db2, { id: "bt:1", phase: "CANCELLING", generation: 1 });
  db2.prepare(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,detail)
               VALUES(100,'bt:1',?,'task.cancelling','IMPLEMENTING','CANCELLING','{}')`).run(ENTERED);
  const noThreshold = applyTransition(db2, { taskId: "bt:1", expectedPhase: "CANCELLING", expectedGeneration: 1,
    evidence: { kind: "founder.cancelForce", drainEligible: true }, op: "task.cancelled",
    now: ENTERED + 86400 });
  check(noThreshold.applied === false && /drainMinutes/.test(noThreshold.refusal ?? ""),
    "a --force with no configured threshold is refused, not defaulted", JSON.stringify(noThreshold));
  db.close(); db2.close();
}

// ── FINALIZING -> DONE forgives voided effects ONE BY ONE ────────────────────
// The forgiveness rule is per EFFECT: a voided row stops mattering when the
// resume re-enqueued that same idempotency key and the replacement reached
// `done`. Asking "is there ANY replacement" and dropping the whole voided group
// on a single yes is how a task commits DONE -- terminal, no edges out -- with
// its ledger write-back never performed.
//
// The fixture is the smallest one that can tell the two apart: TWO voided
// completion effects, exactly ONE replaced. A group-level check sees one
// replacement and forgives both; a correlated check forgives one and refuses.
{
  // t7b, not t7: the resume block above already opened t7 and seeded `bt:1`,
  // and `task` is UNIQUE on (source_kind, source_key) -- so reopening it aborts
  // at the fixture before this block tests anything. The same collision the
  // outbox task caught between o5 and o6, in a task that did not get the fix.
  const db = openHub(join(dir, "t7b.db"));
  seed(db, { id: "bt:1", phase: "FINALIZING", generation: 1 });
  // The completion check scopes itself to the FINALIZING entry for this
  // generation and refuses outright without one, so the fixture supplies it.
  db.prepare(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(200,'bt:1',unixepoch(),'phase.advanced','SLICE_MERGED','FINALIZING',1,1,'{}')`).run();
  const put = (key, status) => db.prepare(
    `INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,status,args,created_at,updated_at)
     VALUES(?,'gh.pr.comment','bt:1',1,200,?,'{}',unixepoch(),unixepoch())`).run(key, status);
  put("bt:1:g1:ledger-writeback", "voided");
  put("bt:1:g1:pr-close",         "voided");
  put("bt:1:g1:pr-close",         "done");     // ONE replacement, for ONE of the two
  const settle = () => applyTransition(db, { taskId: "bt:1", expectedPhase: "FINALIZING",
    expectedGeneration: 1, evidence: { kind: "finalize.settled", outstanding: 0 }, op: "phase.advanced" });

  const partial = settle();
  check(partial.applied === false && /1 voided/.test(String(partial.refusal)),
    "one replaced voided effect does not forgive the other, and the count reported is the UNREPLACED one",
    JSON.stringify(partial));
  check(db.prepare("SELECT phase FROM task WHERE id='bt:1'").get().phase === "FINALIZING",
    "and the task is still FINALIZING, because DONE cannot be revisited once entered");

  // CONTROL: replace the second one too and the SAME call commits. Without it a
  // completion check that refuses whenever any voided row exists -- the obvious
  // over-fix -- satisfies both assertions above.
  put("bt:1:g1:ledger-writeback", "done");
  const complete = settle();
  check(complete.applied === true && complete.to === "DONE",
    "control: with EVERY voided effect replaced, the same transition commits",
    JSON.stringify(complete));
  db.close();
}

// ── a replacement must POSTDATE the void it forgives ─────────────────────────
// The correlation on `idempotency_key` alone matches any historical `done` row.
// This is the plain-resume sequence, which the design deliberately permits: an
// effect completes, the resume re-enqueues the same key beside its history, and
// a hold then voids the NEW row. The old completion satisfies a key-only
// subquery, so FINALIZING commits DONE while the delivery that actually
// mattered was abandoned. `d.id > v.id` is what makes "replacement" mean
// "afterwards" -- `outbox.id` is INTEGER PRIMARY KEY and therefore monotonic.
{
  const db = openHub(join(dir, "t8.db"));
  seed(db, { id: "bt:1", phase: "FINALIZING", generation: 1 });
  db.prepare(`INSERT INTO phase_event(seq,task,at,op,from_phase,to_phase,from_generation,to_generation,detail)
              VALUES(200,'bt:1',unixepoch(),'phase.advanced','SLICE_MERGED','FINALIZING',1,1,'{}')`).run();
  const put = (key, status) => db.prepare(
    `INSERT INTO outbox(idempotency_key,kind,task_id,task_generation,fence,status,args,created_at,updated_at)
     VALUES(?,'gh.pr.comment','bt:1',1,200,?,'{}',unixepoch(),unixepoch())`).run(key, status);
  const settle = () => applyTransition(db, { taskId: "bt:1", expectedPhase: "FINALIZING",
    expectedGeneration: 1, evidence: { kind: "finalize.settled", outstanding: 0 }, op: "phase.advanced" });

  put("bt:1:g1:comment", "done");        // the ORIGINAL delivery -- lower id
  put("bt:1:g1:comment", "voided");      // re-enqueued, then voided -- HIGHER id
  const stale = settle();
  check(stale.applied === false && /1 voided/.test(String(stale.refusal)),
    "a done row that PREDATES the void does not forgive it: a replacement has to postdate what it replaces",
    JSON.stringify(stale));

  // CONTROL: enqueue the replacement AFTER the void and the same call commits.
  // Without it, an over-fix that never forgives a voided row at all -- which
  // would deadlock every legitimate resume in FINALIZING -- passes the line
  // above.
  put("bt:1:g1:comment", "done");
  const after = settle();
  check(after.applied === true && after.to === "DONE",
    "control: a replacement enqueued AFTER the void does forgive it", JSON.stringify(after));
  db.close();
}
// ── record-drain runs LAST, so it sees what the cancel itself enqueued ──────
// It snapshots what is OUTSTANDING, so anything that enqueues has to run before
// it. Ordered ahead of `close-prs` it captures only rows that were already
// inflight and misses the close and comment effects the cancellation just
// created -- so `drainRemaining` reads zero and the task can reach CANCELLED
// with its own compensations still pending, which is the one thing the drain
// exists to prevent.
{
  const db = openHub(join(dir, "t10.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  db.exec(`INSERT INTO impl_pr(task,generation,slice,repo_id,pr,head_sha,created_at)
           VALUES('bt:1',1,0,1,7,'${"c".repeat(40)}',unixepoch())`);
  const r = applyTransition(db, { taskId: "bt:1", expectedPhase: "IMPLEMENTING", expectedGeneration: 1,
    evidence: { kind: "founder.cancel" }, op: "task.cancelling" });
  check(r.applied && r.to === "CANCELLING", "the cancel applies", JSON.stringify(r).slice(0, 160));

  // The close and the comment are enqueued BY the cancellation's own
  // compensations, so they exist only if `close-prs` ran before `record-drain`.
  const enqueued = db.prepare(
    "SELECT id, kind FROM outbox WHERE task_id='bt:1' AND status='pending'").all();
  check(enqueued.some(e => e.kind === "gh.pr.close"),
    "fixture: the cancellation enqueued its own PR-close effect",
    JSON.stringify(enqueued.map(e => e.kind)));
  const drained = db.prepare("SELECT outbox_id FROM task_drain WHERE task='bt:1'").all().map(d => d.outbox_id);
  const missing = enqueued.filter(e => !drained.includes(e.id)).map(e => e.kind);
  check(missing.length === 0,
    "record-drain captured every effect the cancellation enqueued, so it ran last",
    `not drained: ${missing.join(", ") || "(none)"}`);
  check(db.prepare(
    "SELECT count(*) c FROM task_drain WHERE task='bt:1' AND settled_at IS NULL").get().c === enqueued.length,
    "so drainRemaining counts them all and CANCELLED is not yet legitimate",
    `${db.prepare("SELECT count(*) c FROM task_drain WHERE task='bt:1' AND settled_at IS NULL").get().c} vs ${enqueued.length}`);
  db.close();
}

// ── a compensation this module cannot apply is LOUD ─────────────────────────
// A name the machine can emit and the transaction cannot apply either throws or
// silently does nothing -- and silence looks exactly like success, which is how
// `regrant-territory` was emitted for a round with no branch to run it.
{
  const db = openHub(join(dir, "t11.db"));
  seed(db, { id: "bt:1", phase: "IMPLEMENTING", generation: 1 });
  let threw = null;
  try {
    hubTx(db, () => applyCompensation(db, { c: "not-a-compensation", taskId: "bt:1",
                                            generation: 1, seq: null, evidence: {} }));
  } catch (e) { threw = e; }
  check(threw !== null, "an unknown compensation throws rather than doing nothing", String(threw));
  check(/not-a-compensation/.test(String(threw?.message)),
    "and names the one it could not apply", String(threw?.message).slice(0, 120));
  check(COMPENSATIONS.length === 14,
    "control: the closed set is the fourteen the machine can emit", `${COMPENSATIONS.length}`);
  // CONTROL: a REAL name does not throw, so the assertion above is about the
  // unknown name and not about the switch refusing everything.
  let ok = true;
  try { hubTx(db, () => applyCompensation(db, { c: "void-pending", taskId: "bt:1",
                                                generation: 1, seq: null, evidence: {} })); }
  catch { ok = false; }
  check(ok, "control: a name from the closed set applies without throwing");
  db.close();
}

rmSync(dir, { recursive: true, force: true });
console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
