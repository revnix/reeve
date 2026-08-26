// transition -- the one shape every phase change takes.
//
// Exactly one BEGIN IMMEDIATE that: CAS-updates the projection, appends the
// phase_event and the hub_event, records the artifact sha that justified it,
// and ENQUEUES side effects rather than performing them. Nothing here talks to
// the network; an effect that reaches the outside world does so from the outbox
// executor, after its fence revalidates.
//
// The CAS predicate carries the generation as well as the phase. A phase-only
// predicate lets a stale attempt from generation 3 act on a task that a
// --redesign moved into generation 4 -- same phase, successful update, task
// advanced by work done under a contract nobody approved.
//
// Zero rows changed means a concurrent actor won. That is a no-op and not an
// error: the loop is allowed to race with itself and with a founder command,
// and turning every race into a thrown exception makes the caller invent a
// recovery for something that needs none.
import { hubTx, hubEvent, canonicalHub } from "./hubdb.mjs";
import { assertWritable } from "./locks.mjs";
// `HOLD_ESCALATION` and `holdReasonFor` are exported BY phases.mjs and imported
// here: the stacked-hold branch indexes the first and calls the second, and a
// second copy of either would be a second closed set to drift from the DDL.
import { nextPhase, HELD, isSliceReport, HOLD_ESCALATION, holdReasonFor, ACTIVE } from "./phases.mjs";
import { isSameProcess } from "../supervisor.mjs";       // build/ is one level down
import { enqueueEffect, voidPendingIn } from "./outbox.mjs";
// ONE claim model, shared with admission. A resume that decided territory its
// own way granted paths a live lease already covered by ancestry; see
// territory.mjs.
import { LEASE_COLS, liveLeases, firstConflict, grantLease }
  from "./territory.mjs";
// ONE way to ask what a task has open. See prs.mjs for why this is a module and
// not five hand-merged queries.
import { openPrs, hasOpenPr as anyOpenPr } from "./prs.mjs";

// "Open" means the PR exists and is NOT YET MERGED, and both halves are
// corrections that pull in opposite directions.
//
// Excluding HELD PRs made `hasOpenPr` false exactly when the task was already
// BLOCKED or ESCALATED -- a legal source for `founder.cancel` and
// `founder.infeasible` -- so `nextPhase` omitted `write-pr-hold`, the upsert
// never ran, and the open hold kept its obsolete non-terminal reason on a task
// that had just been cancelled. So held PRs are IN.
//
// But dropping every condition went too far. `impl_pr` is durable history: rows
// persist after the PR merges and record it via `merged_sha`, and the primary
// key is (task, generation, slice), so an earlier generation's merged PR keeps
// this true forever. Terminal transitions then scheduled holds, comments and
// close effects against a PR that merged weeks ago -- and a cancellation that
// cannot drain is a task that cannot reach a terminal phase.
// Both kinds, because `task_pr` holds both. This used to count implementation
// rows and then ask `task` for the spec PR separately, which is the merge that
// three review rounds each taught to one more site.
const hasOpenBuilderPr = anyOpenPr;

// THE LEASE'S DEADLINE, not the claim's intent. hub.sql calls
// `territory_lease.pinned_until` "the ONLY home of the pin", and
// `task_territory.pinned` is what the FILING asked for -- a durable bit that
// nothing ever clears. Reading the bit meant `release-territory` was omitted on
// every hold of a task that was EVER pinned, and since a lease is live while its
// task is non-terminal, the expired pin then blocked every overlapping filing
// for ever rather than until its deadline. A pin is a promise with an end.
const hasLivePin = (db, taskId) => db.prepare(
  `SELECT count(*) c FROM territory_lease
    WHERE task = ? AND pinned_until IS NOT NULL AND pinned_until > unixepoch()`)
  .get(taskId).c > 0;

// The compensations `nextPhase` may emit. A name the machine can produce and
// this module cannot apply either throws and rolls the transition back, or --
// worse -- silently does nothing and looks like it worked.
const COMPENSATIONS = Object.freeze([
  "void-pending", "write-pr-hold", "close-prs", "release-territory",
  "regrant-territory", "clear-holds", "clear-holds-except-closing",
  "annotate-held", "annotate-resumed",
  "record-hold-reason",
  "adopt-snapshot", "release-ledger-claim", "terminate-worker",
  "record-research-skip", "record-drain", "force-drain",
]);

/**
 * A compensation that REFUSES, as opposed to one that fails.
 *
 * `regrant-territory` re-runs the intersection check under the write lock and
 * must abandon the whole resume when another task now holds the paths -- and the
 * only way to undo the writes already made in this transaction is to throw, so
 * that `hubTx` rolls back. But a caller asked for a transition and is owed an
 * answer, not an exception: every other refusal in this module returns
 * `{ applied: false }`, and a resume that raises where a hold returns would make
 * the caller handle one outcome two ways.
 *
 * So it throws inside and is converted at the boundary. The distinct type is
 * what keeps that conversion honest: a genuine defect -- a null dereference, a
 * constraint nobody anticipated -- must still propagate, and a bare `catch`
 * around the transaction would swallow it and report a tidy refusal.
 */
export class CompensationRefused extends Error {
  constructor(message) { super(message); this.name = "CompensationRefused"; }
}

// The outbox statuses from which a delivery may still follow. Anything else is
// an obligation that has been dropped, whatever the reason.
const LIVE_OUTBOX = Object.freeze(["pending", "inflight"]);

const PR_HOLD_COLS = `id, task, repo_id, pr, head_sha, reason, detail, created_at, cleared_at`;
const HOLD_REASON_COLS = `id, task, reason, detail, at, cleared_at`;
const DRAIN_COLS = `task, outbox_id, recorded_at, settled_at, forced, last_known`;

// A territory lease lasts as long as the task holds it; the loop renews. The
// value is a bound, not a schedule, so it lives here rather than in a profile.

/**
 * Apply ONE compensation, inside the caller's transaction.
 *
 * Every branch appends its own row image, because each writes a replayed
 * projection and replay is a primary-key upsert: a write with no event is undone
 * by the next restore. The `default` THROWS rather than returning, so a
 * compensation the machine emits and this switch cannot apply rolls the
 * transition back loudly instead of half-applying it.
 */
export function applyCompensation(db, { c, taskId, generation, seq, evidence = {}, snapshot = null }) {
  const task = db.prepare("SELECT * FROM task WHERE id = ?").get(taskId);
  const enqueue = (kind, key, args, { cancellable = true } = {}) =>
    enqueueEffect(db, { idempotencyKey: key, kind, taskId, generation,
                        fence: seq, cancellable, args });

  switch (c) {
    // Only `cancellable = 1 AND status = 'pending'`. Voiding a push mid-transport
    // is not a compensation: the bytes may already be on the wire.
    case "void-pending":
      voidPendingIn(db, taskId);
      return;

    // ONE row per open builder PR, as an UPSERT on the OPEN row rather than a
    // bare insert. BLOCKED and ESCALATED are both legal sources for
    // `founder.cancel` and `founder.infeasible`, and a held task already has an
    // open hold for each of its PRs -- so a plain insert hits
    // `one_open_hold(repo_id, pr) WHERE cleared_at IS NULL` and aborts the whole
    // terminal transition.
    //
    // `head_sha` is read from `impl_pr` INSIDE this transaction. The projection
    // is where the PR's current head lives; taking it from the caller would let
    // a value read before BEGIN IMMEDIATE be written as the hold's witness.
    case "write-pr-hold": {
      // THE HOLD REASON COMES FROM THE TRANSITION, not from the shape of a field
      // that means different things in different transitions.
      //
      // `pr_hold.reason` is a closed CHECK. Only the `hold` transition carries a
      // member of that enum in `evidence.reason`; `founder.infeasible` REQUIRES
      // `evidence.reason` and requires it to be a free-form explanation of why
      // work stopped, which is the whole point of a terminal state that has to
      // be explainable afterwards. Reading it as an enum meant a perfectly
      // ordinary `dependency cannot be licensed` threw inside `holdReasonFor`
      // and rolled back the entire terminal transition -- the task stayed where
      // it was, and the more carefully the founder explained themselves the more
      // certainly it failed.
      //
      // So the enum is derived from the kind, and the explanation is kept in
      // `detail`, which is the column that exists to hold free text.
      const fromHold = evidence?.kind === "hold";
      // `depth_post_approval` is a member of pr_hold's CHECK and of
      // HOLD_ESCALATION, the machine emits it, and `record-hold-reason` writes it
      // to the task -- so classifying the PR's hold as the generic `escalated`
      // made the hold and its own task disagree about why the work stopped, in
      // the row a guardian reads to explain the block.
      const reason = fromHold ? holdReasonFor(evidence.reason)
                   : evidence?.kind === "founder.cancel"  ? "cancel"
                   : evidence?.kind === "depth.override"  ? "depth_post_approval"
                   : "escalated";
      const detail = fromHold
        ? (evidence.reason === "blocked_other"
            ? (evidence.escalation ?? evidence.detail ?? null) : (evidence.detail ?? null))
        // The founder's words, preserved. `founder.infeasible` mandates them and
        // there is no later phase in which to record them.
        : (evidence?.detail ?? evidence?.reason ?? null);
      // EVERY OPEN BUILDER PR, which for a task that has not started implementing
      // means its SPEC PR.
      //
      // `pr_hold` exists so the guardian's verdict finds a row and renders BLOCK,
      // making the PR unmergeable while the task is stopped -- and hub.sql says
      // that applies "on CANCELLING, ESCALATED and BLOCKED". This loop read
      // `impl_pr` alone, so `gate.capReached` -- which by definition happens at
      // GATE, with a spec PR open and no implementation PR yet -- wrote no hold at
      // all. The task sat ESCALATED with its spec PR still mergeable, which is the
      // exact outcome a fail-closed stop exists to prevent, and the compensation
      // that was supposed to prevent it did nothing.
      //
      // Keyed on the transition rather than on which rows happen to exist:
      // `depth.override` and `founder.regenerate` re-render the spec and push a
      // NEW HEAD to that same PR, so holding it there would block the work they
      // are dispatching.
      // A DENYLIST, not an allowlist, because the allowlist was wrong by omission
      // twice. It named four kinds that hold the spec PR and left out
      // `phase.failed` -- so a revision-loop task back in SPEC_DRAFT whose worker
      // exhausted its retries escalated with its spec PR still mergeable, which
      // is the same defect `gate.capReached` was added to fix, reached by a
      // different edge. An allowlist has to be extended for every new transition
      // and fails OPEN when someone forgets; this fails closed.
      //
      // The only reason not to hold a spec PR is that the transition is about to
      // push a NEW HEAD to it: a depth override and a regenerate both re-render
      // the spec, and holding it would block the work they are dispatching.
      const KEEPS_SPEC_OPEN = ["depth.override", "founder.regenerate"];
      const holdable = KEEPS_SPEC_OPEN.includes(evidence?.kind)
        ? openPrs(db, taskId, { kind: "impl" })
        : openPrs(db, taskId);
      for (const pr of holdable) {
        const open = db.prepare(
          `SELECT id FROM pr_hold WHERE repo_id = ? AND pr = ? AND cleared_at IS NULL`)
          .get(pr.repo_id, pr.pr);
        let id;
        if (open) {
          db.prepare(`UPDATE pr_hold SET reason = ?, detail = ?, head_sha = ? WHERE id = ?`)
            .run(reason, detail, pr.head_sha, open.id);
          id = open.id;
        } else {
          id = db.prepare(
            `INSERT INTO pr_hold(task, repo_id, pr, head_sha, reason, detail, created_at)
             VALUES(?,?,?,?,?,?,unixepoch()) RETURNING id`)
            .get(taskId, pr.repo_id, pr.pr, pr.head_sha, reason, detail).id;
        }
        hubEvent(db, { kind: "pr_hold.created", task: taskId,
          payload: db.prepare(`SELECT ${PR_HOLD_COLS} FROM pr_hold WHERE id = ?`).get(id) });
      }
      return;
    }

    // The close, and the comment that explains it. Enqueued, never performed:
    // the executor revalidates the fence inside its lease transaction.
    case "close-prs": {
      // Terminal abandonment closes BOTH kinds; a redesign or a regenerate closes
      // only the implementation PRs, because the spec PR is fixed for the task's
      // life and they are about to push a new head to it.
      const abandoning = evidence?.kind === "founder.cancel" || evidence?.kind === "founder.infeasible";
      const open = abandoning ? openPrs(db, taskId) : openPrs(db, taskId, { kind: "impl" });
      // THE REPOSITORY IS PART OF THE KEY. A pull-request number is unique only
      // within its repository, and this list now spans two of them -- so a spec
      // PR and an implementation PR that happen to share a number produced the
      // same idempotency key, `enqueueEffect` returned the second as a duplicate,
      // and `record-drain` never saw it. The task then reached CANCELLED or
      // INFEASIBLE with one of its PRs permanently open, and the drain that
      // exists to prove otherwise agreed that everything had settled.
      // THE CLOSE STAYS CANCELLABLE, deliberately, and the hold is what carries
      // the obligation instead.
      //
      // Making it non-cancellable was the obvious repair and it is wrong: the row
      // then survives into `record-drain`, and the next resume is refused while
      // it is outstanding -- so a task could not resume until GitHub was
      // reachable, which is the very failure this branch removed from the hold
      // comment two rounds ago. A safety property must not be bought with a
      // liveness one.
      //
      // So the PR's hold outlives every resume until its close actually lands
      // (see `clear-holds`), which closes the mergeable window on its own, and a
      // resume RE-ENQUEUES a close that a hold voided. Voided and re-enqueued is
      // a cycle that converges; open and unheld is not.
      for (const pr of open) {
        enqueue("gh.pr.comment", `${taskId}:g${generation}:r${pr.repo_id}:pr${pr.pr}:close-notice`,
                { repo_id: pr.repo_id, pr: pr.pr, reason: evidence?.kind ?? null,
                  ...(pr.kind === "spec" ? { repo: "spec" } : {}) });
        enqueue("gh.pr.close", `${taskId}:g${generation}:r${pr.repo_id}:pr${pr.pr}:close`,
                { repo_id: pr.repo_id, pr: pr.pr, ...(pr.kind === "spec" ? { repo: "spec" } : {}) });
      }
      return;
    }

    // `territory_lease` is a REPLAYED projection separate from `task_territory`
    // -- the claims are the task's, the lease is the grant -- so a release with
    // no event is undone by replay and the territory is held by a ghost.
    case "release-territory": {
      const at = db.prepare("SELECT unixepoch() n").get().n;
      const held = db.prepare(`SELECT ${LEASE_COLS} FROM territory_lease WHERE task = ?`).all(taskId);
      for (const lease of held) {
        // AN EXPIRED PIN IS SPENT, AND THAT HAS TO OUTLIVE THE LEASE.
        //
        // The two halves of a pin were kept in places with different lifetimes:
        // the INTENT in `task_territory.pinned`, which is durable, and the
        // DEADLINE in `territory_lease.pinned_until`, which this delete destroys.
        // So carrying the original deadline across a resume -- the fix that made
        // a pin a deadline rather than a renewable lease -- held only until the
        // next hold. A hold releases territory precisely when no pin is live, the
        // row went with it, and the resume after that found no row, read the
        // still-set intent bit, and minted `now + LEASE_SECONDS`. One extra
        // hold/resume cycle and the expired pin was live again, blocking
        // overlapping filings past the deadline the founder actually set.
        //
        // Recording the end where the intent lives is what makes them one fact.
        // An intent bit with no live pin at release time is spent by
        // construction: the hold paths emit this compensation only when
        // `pinnedTerritory` is false, and a terminal task does not resume.
        //
        // AND THE CLEAR IS EVENTED, because `task_territory` is a replayed
        // projection like the lease is. An unrecorded write is undone by the
        // next restore, which would put the intent bit back and hand the same
        // resurrection back to the resume that follows it.
        if (lease.pinned_until !== null && lease.pinned_until <= at) {
          const claim = db.prepare(
            `UPDATE task_territory SET pinned = 0
              WHERE task = ? AND kind = ? AND path = ?
              RETURNING task, kind, path, pinned`)
            .get(taskId, lease.kind, lease.path);
          if (claim) hubEvent(db, { kind: "task_territory.claimed", task: taskId, payload: claim });
        }
        db.prepare(`DELETE FROM territory_lease WHERE project=? AND kind=? AND path=?`)
          .run(lease.project, lease.kind, lease.path);
        hubEvent(db, { kind: "territory_lease.released", task: taskId, payload: lease });
      }
      return;
    }

    // AND THE INTERSECTION CHECK IS RE-RUN HERE, under BEGIN IMMEDIATE.
    //
    // `nextPhase`'s `territoryConflict` is the caller's earlier read, taken
    // before this transaction existed; only a check holding the write lock
    // excludes a filing that landed in between. A conflict THROWS, which rolls
    // the whole resume back -- the task stays held rather than returning to work
    // beside another task editing the same paths.
    case "regrant-territory": {
      const at = db.prepare("SELECT unixepoch() n").get().n;
      // THE SAME SCAN ADMISSION RUNS, not an exact-path lookup. A held task
      // resuming beside a live lease on an ancestor, a descendant, or the same
      // path filed under the other claim kind found no row on the exact key,
      // inserted under a different primary key, and both tasks resumed holding
      // paths `overlaps()` calls mutually exclusive.
      const held = liveLeases(db, task.project);
      for (const claim of db.prepare(
        `SELECT kind, path, pinned FROM task_territory WHERE task = ?`).all(taskId)) {
        const holder = firstConflict(claim, held, taskId);
        if (holder)
          throw new CompensationRefused(
            `territory ${claim.kind} ${claim.path || "(repository root)"} overlaps ` +
            `${holder.kind} ${holder.path || "(repository root)"}, held by ${holder.task} ` +
            `until ${holder.expires_at}; ` +
            `the resume is refused rather than granting two tasks the same paths`);
        // THE ORIGINAL DEADLINE, not a fresh one. `task_territory.pinned` is a
        // durable bit saying the filing ASKED for a pin; the deadline lived on
        // the lease. Deriving a new `now + LEASE_SECONDS` from that bit renews a
        // pin the founder time-boxed every time the task resumes -- and if it is
        // held again inside the renewed window it keeps blocking overlapping
        // filings past the expiry that was actually requested. A pin that
        // renews itself on resume is not a deadline.
        //
        // An EXPIRED pin regrants unpinned: the promise was kept and it ended.
        // THE ROW, not the column. A missing `pinned_until` is ambiguous on its
        // own: it means "this lease was never pinned" AND "there is no lease
        // here at all", and those want opposite answers. A held task whose
        // territory was RELEASED has no row, so its resume is making a FRESH
        // promise and takes a fresh deadline; a row that still exists carries
        // whatever deadline it has, including none.
        const prior = db.prepare(
          `SELECT pinned_until FROM territory_lease
            WHERE project=? AND kind=? AND path=? AND task=?`)
          .get(task.project, claim.kind, claim.path, taskId);
        const priorPin = prior ? (prior.pinned_until ?? null) : undefined;
        const granted = grantLease(db, { project: task.project, claim, taskId, at,
                                         pinned: !!claim.pinned, pinnedUntil: priorPin });
        hubEvent(db, { kind: "territory_lease.granted", task: taskId, payload: granted });
      }
      return;
    }

    // Both tables, and a row image per row cleared. A cleared row is the row at
    // a later state, not a different entity, so replay upserts it on the same
    // key -- without the event a snapshot holding open reasons plus a later
    // resume replays into an active task whose reasons are still open, and
    // `task why` reports a cause that was cleared before the restore.
    // A redesign and a regenerate ABANDON their implementation PRs, and the
    // close is enqueued rather than performed. Clearing those holds here leaves
    // an open PR with nothing making it unmergeable in the window before the
    // close lands -- and if the close is delayed, retried, or refused because
    // `publishPr` is off, that window has no end. The hold is the only thing
    // that stops superseded work being merged, so it outlives the decision to
    // close the PR and is cleared by the close settling, not by the resume.
    //
    // The SPEC PR's hold is cleared: it is reused rather than abandoned, and the
    // transition is about to push a new head to it.
    case "clear-holds-except-closing":
    case "clear-holds": {
      const keepHeld = c === "clear-holds-except-closing"
        ? new Set(openPrs(db, taskId, { kind: "impl" }).map(p => `${p.repo_id}:${p.pr}`))
        : new Set();
      // AND NEITHER VARIANT CLEARS A HOLD WHOSE CLOSE HAS NOT LANDED.
      //
      // Retaining the hold on the strength of the CURRENT transition's type was
      // the defect: the obligation belongs to the pull request, not to whichever
      // resume happens to be running. A redesign retained the hold and enqueued
      // the close; a later ordinary resume, several transitions away, knew
      // nothing about either and cleared it.
      //
      // The obligation is read from the outbox, where it durably is. Anything
      // short of `done` keeps the hold -- including a close that was dead-
      // lettered or fenced, because a superseded pull request nothing will ever
      // close is precisely the one that must stay held and visible. Fail-closed:
      // the hold outlives the decision to close, and only the close landing
      // clears it.
      // PER PULL REQUEST, not per row. The obligation is "this PR gets closed",
      // and a hold voids the close while the next resume enqueues a replacement
      // -- so a PR accumulates close rows, and asking "is any row not done" keeps
      // answering yes for ever because the ORIGINAL voided row never becomes
      // done. The hold then never cleared and every resume enqueued another
      // close, repeating an external operation a successor had already
      // completed. Any successful close satisfies the obligation, whichever row
      // carried it.
      // THE LATEST ATTEMPT DECIDES, not "was there ever a success".
      //
      // Collecting the flags separately let an OLD `done` forgive a NEWER dropped
      // close: a pull request closed, reopened, and re-closed by an attempt that
      // was then voided still looked satisfied, so the hold cleared and the
      // reopened superseded PR became mergeable again. History is not the
      // question -- the state of the most recent obligation is. Rows arrive in
      // `id` order, which is enqueue order, so the last one for a PR is that
      // obligation and its status is the answer.
      const byPr = new Map();
      for (const row of db.prepare(
        `SELECT o.args, o.status, o.kind, o.idempotency_key FROM outbox o
          WHERE o.task_id = ? AND o.kind = 'gh.pr.close'
          ORDER BY o.id`).all(taskId)) {
        let a; try { a = JSON.parse(row.args); } catch { continue; }
        if (a?.repo_id == null || a?.pr == null) continue;
        byPr.set(`${a.repo_id}:${a.pr}`, { row, args: a });
      }
      for (const [key, { row, args }] of byPr) {
        if (row.status === "done") continue;        // the PR is closed; the hold may clear
        keepHeld.add(key);
        // AND RE-ESTABLISHED IF A HOLD VOIDED IT. A PR with no successful close
        // and nothing still going to happen is an obligation that was dropped:
        // it stays held, correctly, but nothing is left to ever close it.
        // Re-enqueued with its ORIGINAL key and args -- the same logical act, and
        // `enqueueEffect`'s key is unique over LIVE rows only, so the dead row
        // does not refuse it.
        if (!LIVE_OUTBOX.includes(row.status)) enqueue(row.kind, row.idempotency_key, args);
      }
      for (const h of db.prepare(
        `SELECT id, repo_id, pr FROM pr_hold WHERE task = ? AND cleared_at IS NULL`).all(taskId)) {
        if (keepHeld.has(`${h.repo_id}:${h.pr}`)) continue;
        db.prepare(`UPDATE pr_hold SET cleared_at = unixepoch() WHERE id = ?`).run(h.id);
        // `pr_hold.cleared` rather than `pr_hold.created`: both are declared in
        // HANDLERS against the same table and the same key, so replay treats
        // them identically, and the name that says what happened is the one to
        // write in a log a human reads.
        hubEvent(db, { kind: "pr_hold.cleared", task: taskId,
          payload: db.prepare(`SELECT ${PR_HOLD_COLS} FROM pr_hold WHERE id = ?`).get(h.id) });
      }
      // The task-level reasons clear either way: the task IS resuming, whatever
      // happens to the pull requests it is abandoning.
      for (const r of db.prepare(
        `SELECT id FROM hold_reason WHERE task = ? AND cleared_at IS NULL`).all(taskId)) {
        db.prepare(`UPDATE hold_reason SET cleared_at = unixepoch() WHERE id = ?`).run(r.id);
        hubEvent(db, { kind: "hold_reason.appended", task: taskId,
          payload: db.prepare(`SELECT ${HOLD_REASON_COLS} FROM hold_reason WHERE id = ?`).get(r.id) });
      }
      return;
    }

    // The compensating comment for a hold comment left behind on an open PR.
    // The hold's explanation, for the people on the pull request. `write-pr-hold`
    // writes the row a GUARDIAN reads; this is what a human sees. Keyed on the
    // generation and the hold reason, so a re-hold under a NEW cause posts again
    // while a replayed transition does not.
    case "annotate-held": {
      // BOTH KINDS. A task held at SPEC_PR_OPEN or GATE has only a spec PR, and
      // these annotations read implementation rows alone -- so the one PR its
      // participants were watching said nothing at all. The key carries the
      // repository for the same reason the close keys do: a number is unique
      // only within one.
      for (const pr of openPrs(db, taskId))
        enqueue("gh.pr.comment",
                // `resume_seq` makes each HOLD OCCURRENCE distinct. Without it a
                // task resumed and then held again for the same reason in the
                // same generation produced the identical key, and the comment
                // reconciler identifies delivery by that marker -- so it can
                // settle the second hold against the FIRST hold's comment,
                // leaving the thread with a "resumed" note and no explanation
                // for the hold that followed it.
                `${taskId}:g${generation}:r${task.resume_seq}:repo${pr.repo_id}:pr${pr.pr}` +
                `:held:${evidence?.reason ?? "held"}`,
                { repo_id: pr.repo_id, pr: pr.pr, note: "held",
                  ...(pr.kind === "spec" ? { repo: "spec" } : {}),
                  reason: evidence?.reason ?? null,
                  detail: evidence?.reason === "blocked_other"
                    ? (evidence.escalation ?? evidence.detail ?? null)
                    : (evidence?.detail ?? null) });
      return;
    }

    case "annotate-resumed": {
      // NOT THE PRs THIS TRANSITION IS ABOUT TO CLOSE. A redesign resume and a
      // regenerate both run `annotate-resumed` BEFORE `close-prs`, so after the
      // all-PR refactor this posted "resumed" to an implementation PR seconds
      // before closing it -- a thread that announces work restarting on a pull
      // request being abandoned. Those PRs get the close notice, which is the
      // comment that actually explains what happened to them.
      //
      // The spec PR is the exception on exactly these paths: it is REUSED, the
      // transition pushes a new head to it, and it is the one place a "resumed"
      // note is true.
      const closing = evidence?.kind === "founder.regenerate"
                   || (evidence?.kind === "founder.resume" && evidence?.redesign === true);
      for (const pr of (closing ? openPrs(db, taskId, { kind: "spec" }) : openPrs(db, taskId)))
        enqueue("gh.pr.comment",
                `${taskId}:g${generation}:r${task.resume_seq}:repo${pr.repo_id}:pr${pr.pr}:resumed`,
                { repo_id: pr.repo_id, pr: pr.pr, note: "resumed",
                  ...(pr.kind === "spec" ? { repo: "spec" } : {}) });
      return;
    }

    // THE FIRST hold's reason, not only the stacked ones. Without this branch
    // only the already-held path inserted a row, so the original cause of a hold
    // was never recorded and `task resume` listed the stack while silently
    // dropping the reason the task was held for in the first place.
    case "record-hold-reason": {
      const id = db.prepare(
        `INSERT INTO hold_reason(task, reason, detail, at) VALUES(?,?,?,unixepoch()) RETURNING id`)
        .get(taskId, evidence?.reason ?? null, evidence?.detail ?? null).id;
      hubEvent(db, { kind: "hold_reason.appended", task: taskId,
        payload: db.prepare(`SELECT ${HOLD_REASON_COLS} FROM hold_reason WHERE id = ?`).get(id) });
      return;
    }

    // The only compensation that writes nothing but history. RESEARCH produced
    // no artifact, and an absence with no reason attached reads as a lost phase
    // months later, when someone asks why this task has no research to show.
    case "record-research-skip":
      hubEvent(db, { kind: "research.skipped", task: taskId,
        payload: { task: taskId, generation, depth: evidence?.depth ?? task.depth ?? null } });
      return;

    // LAST in every list that contains it, because it snapshots what is
    // OUTSTANDING -- so anything that enqueues has to run before it. `pending`
    // as well as `inflight`: the close and comment effects the compensations
    // above just enqueued are pending, and an inflight-only select would miss
    // exactly the rows ordering this last was meant to catch.
    case "record-drain": {
      for (const row of db.prepare(
        `SELECT id FROM outbox WHERE task_id = ? AND status IN ('pending','inflight')`).all(taskId)) {
        const done = db.prepare(
          `INSERT INTO task_drain(task, outbox_id, recorded_at) VALUES(?,?,unixepoch())
           ON CONFLICT(task, outbox_id) DO NOTHING`).run(taskId, row.id);
        if (!done.changes) continue;        // already recorded by an earlier drain
        hubEvent(db, { kind: "task_drain.recorded", task: taskId,
          payload: db.prepare(`SELECT ${DRAIN_COLS} FROM task_drain WHERE task=? AND outbox_id=?`)
            .get(taskId, row.id) });
      }
      return;
    }

    // EVERY field `nextPhase` validated. Writing a subset is worse than writing
    // none: the generation bump asserts the whole contract was re-resolved, so a
    // task with a new profile hash and an old repository path is a hybrid
    // nothing later can detect. The values were resolved BEFORE the transaction,
    // network first.
    case "adopt-snapshot": {
      if (!snapshot) throw new Error("adopt-snapshot without a resolved snapshot");
      // THE SPEC PR'S REPOSITORY IS PART OF ITS IDENTITY. A regenerate that
      // adopts a snapshot naming a DIFFERENT spec repository used to move
      // `task.spec_repo_id` while the spec PR kept its number and head -- so
      // every later gate, hold, annotation and close read that number as a PR in
      // the new repository, and a PR number is unique only within one. That is
      // not a stale value, it is a live handle on somebody else's pull request.
      //
      // Refused rather than silently rebound: creating a replacement spec PR is a
      // real action with a real head, and inventing one inside a compensation
      // would be the same class of guess.
      {
        const spec = openPrs(db, taskId, { kind: "spec" })[0] ?? null;
        if (spec && snapshot.specRepoId != null && spec.repo_id !== snapshot.specRepoId)
          throw new CompensationRefused(
            `the task's spec PR is #${spec.pr} in repository ${spec.repo_id}, and the new snapshot ` +
            `names ${snapshot.specRepoId}; a regenerate cannot move a spec PR between repositories. ` +
            `Close the existing spec PR first, or regenerate against the repository it lives in`);
      }
      db.prepare(
        `UPDATE task SET repo_id=?, nwo_snapshot=?, repo_path=?, profile_path=?, profile_hash=?,
                         default_branch=?, visibility=?, spec_repo_id=?, gate_definition_hash=?,
                         registry_version=?, founder_user_id=?, updated_at=unixepoch()
          WHERE id=?`)
        .run(snapshot.repoId, snapshot.nwo, snapshot.repoPath, snapshot.profilePath,
             snapshot.profileHash, snapshot.defaultBranch, snapshot.visibility,
             snapshot.specRepoId, snapshot.gateDefinitionHash, snapshot.registryVersion,
             snapshot.founderUserId, taskId);
      return;                       // the row image rides on task.transitioned
    }

    // `--if-owner` makes it inert when a human already owns the node, so
    // emitting it for every ledger-sourced cancellation is the safe direction: a
    // claim that landed is not undone by draining, and the orphan sweep would
    // otherwise find a reeve-owned claim for a task that no longer exists.
    case "release-ledger-claim":
      enqueue("ledger.release", `${taskId}:g${generation}:ledger-release`,
              { node: task.source_key, ifOwner: `reeve:${taskId}` });
      return;

    // INSIDE THE TRANSACTION IT ONLY REVOKES. Killing a process is irreversible
    // and this runs inside hubTx, so a later compensation that throws would roll
    // back the task and the phase_run while the worker stayed dead -- and the
    // write lock would be held across the SIGTERM grace period besides, blocking
    // every other hub writer for seconds. The transaction records the intent; a
    // fenced reconciler on the loop performs the signals for any run marked
    // `killed` whose process is still alive, which is idempotent.
    case "terminate-worker": {
      const live = db.prepare(
        `SELECT task, generation, phase, slice, attempt FROM phase_run
          WHERE task = ? AND status IN ('live','adopted')`).all(taskId);
      for (const r of live) {
        db.prepare(
          `UPDATE phase_run SET status='killed', outcome=?
            WHERE task=? AND generation=? AND phase=? AND slice=? AND attempt=?`)
          .run(canonicalHub({ revoked: true, by: evidence?.kind ?? "transition" }),
               r.task, r.generation, r.phase, r.slice, r.attempt);
        hubEvent(db, { kind: "phase_run.settled", task: taskId,
          payload: db.prepare(
            `SELECT * FROM phase_run WHERE task=? AND generation=? AND phase=? AND slice=? AND attempt=?`)
            .get(r.task, r.generation, r.phase, r.slice, r.attempt) });
      }
      return;
    }

    // A forced cancel is the one terminal transition whose external truth was
    // never confirmed, so what was unknown is written down: the drain rows are
    // marked forced with the last reconciler attempt, and their outbox rows move
    // to the hub-only status `forced` so the executor stops recovering them
    // under a task that is already CANCELLED.
    case "force-drain": {
      for (const row of db.prepare(
        `SELECT outbox_id FROM task_drain WHERE task = ? AND settled_at IS NULL`).all(taskId)) {
        const last = db.prepare("SELECT status, last_error FROM outbox WHERE id = ?").get(row.outbox_id);
        db.prepare(
          `UPDATE task_drain SET forced = 1, settled_at = unixepoch(), last_known = ?
            WHERE task = ? AND outbox_id = ?`)
          .run(canonicalHub({ status: last?.status ?? null, error: last?.last_error ?? null }),
               taskId, row.outbox_id);
        hubEvent(db, { kind: "task_drain.settled", task: taskId,
          payload: db.prepare(`SELECT ${DRAIN_COLS} FROM task_drain WHERE task=? AND outbox_id=?`)
            .get(taskId, row.outbox_id) });
        db.prepare(
          `UPDATE outbox SET status='forced', worker=NULL, updated_at=unixepoch()
            WHERE id = ? AND status IN ('pending','inflight')`).run(row.outbox_id);
        hubEvent(db, { kind: "outbox.settled", task: taskId,
          payload: db.prepare("SELECT * FROM outbox WHERE id = ?").get(row.outbox_id) });
      }
      return;
    }

    // LOUD. A compensation the machine can emit and this switch cannot apply is
    // either a silent no-op -- which looks exactly like success -- or a throw
    // from somewhere far away from the omission that caused it.
    default:
      throw new Error(
        `unknown compensation ${JSON.stringify(c)}; the closed set is ${COMPENSATIONS.join(", ")}`);
  }
}

export { COMPENSATIONS };

export function applyTransition(db, args) {
  try { return applyTransitionTx(db, args); }
  catch (e) {
    // The transaction has already rolled back -- `hubTx` does that before it
    // rethrows -- so the projection is untouched and there is nothing to undo
    // here. Only a REFUSAL is converted; anything else is a defect and must
    // reach the caller as one.
    if (e instanceof CompensationRefused)
      return { applied: false, reason: "refused", refusal: e.message };
    throw e;
  }
}

function applyTransitionTx(db, { taskId, expectedPhase, expectedGeneration, evidence,
                                      artifactSha = null, op, effects = [], slice = null,
                                      now = null, drainMinutes = null,
                                      isAlive = isSameProcess }) {
  // One writer for both shapes, so the refusal path and the success path cannot
  // drift. `sizing.overridden` is the durable record of who changed the depth and
  // to what -- without it `task why` shows a task dispatched under a depth
  // nothing explains.
  //
  // Declared ABOVE the transaction: as a `const` inside `hubTx` it sits in the
  // temporal dead zone when the refusal branch calls it, so an accepted
  // SIZING/RESEARCH/DESIGN override throws on the one path that needs it most.
  // WHICH FACT, not just which value. `persistDepth` now runs on EVERY successful
  // SIZING -- that was the point of recording the classifier's choice at all --
  // and it appended `sizing.overridden` unconditionally, so the durable history
  // claimed the ordinary selection was a founder override. `task why` and every
  // event consumer then misattribute how the depth was chosen, which is a lie in
  // the audit trail rather than a missing entry: worse, because it reads as an
  // answer. The kind is the caller's, and `sizing.overridden` is reserved for
  // actual `depth.override` evidence.
  const persistDepth = (db, taskId, depth, kind) => {
    db.prepare("UPDATE task SET depth=?, updated_at=unixepoch() WHERE id=?").run(depth, taskId);
    hubEvent(db, { kind, task: taskId,
      payload: db.prepare("SELECT id, depth, generation, updated_at FROM task WHERE id = ?").get(taskId) });
  };
  const depthEventFor = (evidence) =>
    evidence?.kind === "depth.override" ? "sizing.overridden" : "sizing.recorded";

  return hubTx(db, () => {
    // Every hub writer checks the restore exclusion first, inside its own
    // transaction. This is the busiest writer in the system; omitting it here
    // would leave the largest hole in the lock.
    assertWritable(db, { isAlive, inTx: true });
    const task = db.prepare("SELECT * FROM task WHERE id=?").get(taskId);
    if (!task) return { applied: false, reason: "no-such-task" };

    const decision = nextPhase({
      // From the TASK ROW, not defaulted. `nextPhase` defaults `sourceKind` to
      // "founder" and the ledger-ownership guard applies only to ledger tasks --
      // so a caller that omits it lets a bare `founder.resume` reactivate a
      // ledger-sourced task with no sync witness, which is the case the guard
      // exists for.
      sourceKind: task.source_kind,
      // Also from the database: regenerate terminates a live worker, and only
      // the phase_run rows know whether one is live.
      hasLiveRun: db.prepare(
        "SELECT count(*) c FROM phase_run WHERE task=? AND status IN ('live','adopted')").get(taskId).c > 0,
      phase: expectedPhase, generation: expectedGeneration, heldFrom: task.held_from,
      sliceCursor: task.slice_cursor, hasOpenPr: hasOpenBuilderPr(db, taskId),
      pinnedTerritory: hasLivePin(db, taskId),
      // TWO QUESTIONS, NOT ONE. `drainRemaining` is everything still outstanding
      // and is what CANCELLING reads: a task cannot claim to be CANCELLED until
      // its own close and notice have actually happened, so the stop's own
      // compensations belong in that count.
      drainRemaining: db.prepare("SELECT count(*) c FROM task_drain WHERE task=? AND settled_at IS NULL").get(taskId).c,
      // A RESUME asks something different: is any of the work the task was DOING
      // still in flight? The hold's own explanatory comment is not that. Counting
      // it made every hold-then-resume refuse until an executor delivered a
      // comment -- and in S2 nothing delivers anything, so the refusal had no
      // end. Scoped by the `fence` of the event that stopped the task: at or
      // after it is the stop's own doing, before it is the work.
      // THE EXACT TEST: was this effect enqueued BY a stop? `fence` is the
      // `phase_event.seq` that authorised the row, so the event itself answers
      // it -- and a hardcoded list of stopped phases here was a second copy of a
      // classification `phases.mjs` already owns, free to drift from it.
      //
      // Comparing against the LATEST stop was correct only while a task had
      // stopped once. Held, resumed while the hold comment was still unsettled,
      // held again: the first hold's own comment has the FIRST stop's fence,
      // which sorts before the second stop, so it was recounted as work the task
      // was doing and every later resume was refused -- indefinitely, if that
      // comment is waiting on a reconciler that cannot reach GitHub.
      drainBeforeStop: db.prepare(
        `SELECT count(*) c FROM task_drain d
           JOIN outbox o ON o.id = d.outbox_id
          WHERE d.task = ? AND d.settled_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM phase_event e
                             WHERE e.task = d.task AND e.seq = o.fence
                               AND e.to_phase NOT IN (${ACTIVE.map(p => `'${p}'`).join(",")}))`)
        .get(taskId).c,
    }, evidence);

    const WORKER_PHASES = ["SIZING","RESEARCH","DESIGN","SPEC_DRAFT","IMPLEMENTING"];
    // ONE durable-refusal exit. Two sites that must both append
    // `transition.refused` is two sites that can diverge, and they had. The rule
    // is mechanical: if a return happens AFTER the phase-and-generation fence and
    // is not `lost-race`, it uses this exit -- `task why` renders this history,
    // and a refusal with no record is indistinguishable from a report that was
    // never sent.
    const refuseDurably = (refusal) => {
      hubEvent(db, { kind: "transition.refused", task: taskId,
        payload: { from: expectedPhase, evidence: evidence?.kind ?? null, refusal } });
      return { applied: false, reason: "refused", refusal };
    };
    // Any path that returns before the CAS must fence ITSELF. Without it a stale
    // caller writes a durable refusal claiming the CURRENT task refused evidence
    // in a phase it has already left.
    const lostRace = () => task.phase !== expectedPhase || task.generation !== expectedGeneration;

    // A transition justified by a phase report must name the artifact that
    // justified it: a null one records a transition whose evidence cannot be
    // re-checked afterwards.
    if (evidence?.kind === "phase.succeeded" && WORKER_PHASES.includes(expectedPhase) && !artifactSha) {
      if (lostRace()) return { applied: false, reason: "lost-race" };
      return refuseDurably(
        `${expectedPhase} succeeded with no artifact sha; a transition must record what justified it`);
    }

    // Keyed on the MACHINE's `stackable`, not on re-derived state. The old
    // predicate -- refused && the phase is held && the evidence is a hold -- is
    // also true of a hold whose reason the machine just REFUSED, so the branch
    // that writes the row ran for exactly the cases that must not write one.
    if (!decision.ok && decision.stackable) {
      if (lostRace()) return { applied: false, reason: "lost-race" };
      db.prepare("INSERT INTO hold_reason(task,reason,detail,at) VALUES(?,?,?,unixepoch())")
        .run(taskId, evidence.reason, evidence.detail ?? null);
      db.prepare("UPDATE pr_hold SET reason=?, detail=? WHERE task=? AND cleared_at IS NULL")
        // `evidence.escalation` for `blocked_other`, not just `detail`: the DDL
        // gives that column its meaning, and the machine already refuses a
        // `blocked_other` without one, so discarding it here throws away the only
        // thing that says who to tell.
        .run(holdReasonFor(evidence.reason),
             evidence.reason === "blocked_other" ? (evidence.escalation ?? evidence.detail ?? null)
                                                 : (evidence.detail ?? null), taskId);
      // AND RAISE IT. This branch returns before the common `decision.escalate`
      // handling, so a hold stacked onto an already-held task notified nobody --
      // and a stacked hold is by definition a NEW independently actionable cause.
      {
        const why = (evidence.reason === "blocked_other"
          ? (evidence.escalation ?? null)
          : HOLD_ESCALATION[evidence.reason])?.replace("bt:<id>", taskId);
        if (why) {
          db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
                      VALUES(?,1,unixepoch(),unixepoch(),0)
                      ON CONFLICT(why) DO UPDATE SET count=count+1, last_seen_at=unixepoch()`).run(why);
          hubEvent(db, { kind: "escalation.raised", task: taskId,
            payload: db.prepare("SELECT why, count, first_seen_at, last_seen_at, announced_count FROM escalation WHERE why = ?").get(why) });
        }
      }
      // BOTH writes need row images: the hold_reason payload has to carry the
      // row's id, which replay keys on, and the pr_hold update had no event at
      // all -- so a replay restored the stacked reason and left the open hold's
      // reason at whatever the snapshot held.
      hubEvent(db, { kind: "hold_reason.appended", task: taskId,
        payload: db.prepare(`SELECT ${HOLD_REASON_COLS} FROM hold_reason
                             WHERE task=? ORDER BY id DESC LIMIT 1`).get(taskId) });
      for (const h of db.prepare(`SELECT ${PR_HOLD_COLS} FROM pr_hold WHERE task=? AND cleared_at IS NULL`).all(taskId))
        hubEvent(db, { kind: "pr_hold.created", task: taskId, payload: h });
      return { applied: false, reason: "stacked" };
    }

    if (!decision.ok) {
      if (lostRace()) return { applied: false, reason: "lost-race" };
      // AN ACCEPTED OVERRIDE IS NOT A REFUSAL. `depth.override` on
      // SIZING/RESEARCH/DESIGN writes the new depth and may terminate the live
      // worker -- a mutation that succeeded -- and returning the same shape as a
      // rejected command leaves the caller to report failure to the founder, or
      // to retry an override that has already been applied.
      if (decision.persistDepth && evidence?.kind === "depth.override") {
        persistDepth(db, taskId, decision.persistDepth, depthEventFor(evidence));
        for (const c of decision.compensations ?? [])
          applyCompensation(db, { c, taskId, generation: expectedGeneration, seq: null, evidence,
                                  snapshot: evidence?.snapshot });
        // `sizing.overridden` is already the declared kind for this and
        // `persistDepth` appends it, so nothing extra is logged here -- and
        // nothing false is.
        return { applied: false, reason: "accepted-no-transition", depth: decision.persistDepth,
                 why: decision.refusal };
      }
      if (decision.persistDepth) persistDepth(db, taskId, decision.persistDepth, depthEventFor(evidence));
      for (const c of decision.compensations ?? [])
        applyCompensation(db, { c, taskId, generation: expectedGeneration, seq: null, evidence,
                                snapshot: evidence?.snapshot });
      return refuseDurably(decision.refusal);
    }

    // `blocked_reason` comes from the hold's cause, and a depth override carries
    // `{kind:"depth.override", depth}` with no `reason` -- so reading the evidence
    // directly wrote a NULL for exactly the hold this derivation exists to name.
    const holdReason = evidence?.kind === "depth.override" ? "depth_post_approval"
                     : evidence?.reason ?? null;
    const TERMINAL_WITH_REASON = ["INFEASIBLE", "CANCELLED", "LOST"];

    // --force is time-gated and the machine has no clock, so eligibility is
    // re-derived from the durable CANCELLING entry rather than trusted from the
    // flag: a founder who ran the command a second after cancelling would
    // otherwise force a drain that had had no window at all.
    if (evidence?.kind === "founder.cancelForce") {
      if (lostRace()) return { applied: false, reason: "lost-race" };
      // A missing threshold REFUSES rather than defaulting. A default here is an
      // invented window, and the one thing this guard exists to prevent is a
      // force that had no window.
      if (drainMinutes == null)
        return refuseDurably("cancel --force needs builder.cancel.drainMinutes; the hub does not store the profile");
      const at = now ?? db.prepare("SELECT unixepoch() n").get().n;
      const enteredAt = db.prepare(
        `SELECT at FROM phase_event WHERE task=? AND to_phase='CANCELLING' ORDER BY seq DESC LIMIT 1`).get(taskId)?.at;
      // No CANCELLING entry means the drain never started. Treating that as zero
      // minutes elapsed happens to refuse, but for the wrong reason and with a
      // message that says the window is still running.
      if (enteredAt == null)
        return refuseDurably("there is no CANCELLING entry to measure the drain window from");
      const mins = (at - enteredAt) / 60;
      if (mins < drainMinutes)
        return refuseDurably(`the drain has had ${Math.floor(mins)}m of its ${drainMinutes}m window`);
    }

    if (decision.to === "DONE") {
      if (lostRace()) return { applied: false, reason: "lost-race" };
      // Scoped by the authorising FENCE, not by a clock: `created_at >= at` is
      // seconds-resolution, so an effect from an earlier phase that failed during
      // the same second FINALIZING was entered would be selected -- and DONE is
      // terminal, so that task could never finish. Every outbox row carries the
      // seq of the phase_event that enqueued it, and seq is monotonic and exact.
      const finalizingSeq = db.prepare(
        `SELECT seq FROM phase_event WHERE task=? AND to_phase='FINALIZING'
           AND to_generation=? ORDER BY seq DESC LIMIT 1`).get(taskId, expectedGeneration)?.seq;
      if (finalizingSeq == null)
        return refuseDurably("there is no FINALIZING entry for this generation to scope the completion check to");
      // LIVE rows always block: a pending or inflight effect has not happened yet,
      // and no later row can speak for it.
      const bad = db.prepare(
        `SELECT status, count(*) c FROM outbox
          WHERE task_id=? AND task_generation=? AND fence >= ?
            AND status IN ('pending','inflight')
          GROUP BY status`).all(taskId, expectedGeneration, finalizingSeq);
      // `voided` is counted SEPARATELY, and PER ROW. It is the one status that
      // can be forgiven -- a voided effect no longer matters if the resume
      // re-enqueued it and the replacement reached `done` -- but forgiveness is
      // per EFFECT, not per group. Asking "is there any voided key with a done
      // replacement" drops the whole group on a single yes, so a task with five
      // abandoned completion effects and one replacement commits DONE with four
      // never performed.
      //
      // `d.id > v.id` is what makes "replacement" mean "afterwards": without it
      // any HISTORICAL done row with the same key forgives the void, and a plain
      // resume deliberately re-enqueues a completed effect beside its history.
      // AND THE UNHAPPY SETTLED ONES, forgiven only by a LATER success on the same
      // key. `voided` was the only status treated this way, and the reasoning
      // applies identically to the other three: a `refused` row is what a
      // capability being off looks like, and re-enabling it re-enqueues the
      // effect under the live-key policy. That replacement reaching `done` left
      // the original counted for ever, so `finalize.settled` could never move the
      // task to DONE -- a task permanently unable to finish because a switch had
      // once been off. Same for a `failed` or `dead_lettered` delivery that a
      // later attempt completed.
      //
      // Forgiveness is per EFFECT, not per group. Asking "is there any voided key
      // with a done replacement" drops the whole group on a single yes, so a task
      // with five abandoned completion effects and one replacement commits DONE
      // with four never performed.
      //
      // `d.id > v.id` is what makes "replacement" mean "afterwards": without it
      // any HISTORICAL done row with the same key forgives it, and a plain resume
      // deliberately re-enqueues a completed effect beside its history.
      const unreplaced = db.prepare(
        `SELECT v.status, count(*) c FROM outbox v
          WHERE v.task_id = ? AND v.task_generation = ? AND v.fence >= ?
            AND v.status IN ('voided','failed','dead_letter','refused')
            AND NOT EXISTS (SELECT 1 FROM outbox d
                             WHERE d.task_id         = v.task_id
                               AND d.task_generation = v.task_generation
                               AND d.idempotency_key = v.idempotency_key
                               AND d.status          = 'done'
                               AND d.id              > v.id)
          GROUP BY v.status`)
        .all(taskId, expectedGeneration, finalizingSeq);
      for (const row of unreplaced) bad.push(row);
      if (bad.length)
        return refuseDurably(`finalization is not complete: ` + bad.map(r => `${r.c} ${r.status}`).join(", ") +
                             `; DONE is terminal and cannot be revisited`);
    }

    // AND THE SLICE, when the caller named one.
    //
    // Phase and generation are not enough for the implementation loop, because it
    // RETURNS to the same phases: a task at slice 1 is in IMPLEMENTING under the
    // same generation it was in for slice 0. So a delayed report from slice 0 --
    // a duplicate `slice.merged` witness is the case that matters -- still
    // matched this CAS and was applied to slice 1, moving it to SLICE_MERGED.
    // `slice.next` then advanced again, or entered FINALIZING, with that slice
    // never merged and nothing recording the gap. The generation fence exists for
    // exactly this shape one level up; the cursor is its equivalent within a
    // generation, and it is already durable on the row.
    //
    // REQUIRED, not optional. The first version fenced only when the caller
    // happened to pass a slice, which makes the guard opt-in: a caller that omits
    // it -- and the parameter DEFAULTS to null -- gets exactly the behaviour the
    // fence was added to prevent, silently. A guard a caller can switch off by
    // forgetting is a guard that protects the callers who did not need it.
    //
    // So the PHASE AND THE EVIDENCE decide, not the caller. `isSliceReport` is
    // the three reports that advance the slice pipeline, from the four phases the
    // loop returns to. A hold, a cancel or a depth override from IMPLEMENTING is
    // about the TASK and has no slice to name; demanding one from them would
    // refuse ordinary transitions, which is how a first version of this fence
    // failed nine assertions that had nothing to do with slices.
    const fenceSlice = isSliceReport(expectedPhase, evidence?.kind);
    if (fenceSlice && (slice === null || slice === undefined))
      return refuseDurably(
        `${expectedPhase} is slice-scoped: the transition must name the slice it reports on, ` +
        `because the task returns to this phase for every slice and the phase alone cannot ` +
        `tell one report from another`);
    const upd = db.prepare(
      `UPDATE task SET phase=?, generation=?, updated_at=unixepoch(),
                       held_from=?, blocked_reason=?, terminal_reason=?,
                       slice_cursor=COALESCE(?, slice_cursor)
       WHERE id=? AND phase=? AND generation=?` +
      (fenceSlice ? ` AND slice_cursor=?` : ``))
      .run(decision.to, decision.generation,
           HELD.includes(decision.to) ? expectedPhase : (decision.to === "CANCELLING" ? task.held_from : null),
           HELD.includes(decision.to) ? holdReason : null,
           TERMINAL_WITH_REASON.includes(decision.to) ? (evidence.reason ?? null) : task.terminal_reason,
           decision.sliceCursor,          // null leaves it alone; slice.next advances it
           taskId, expectedPhase, expectedGeneration,
           ...(fenceSlice ? [slice] : []));
    if (upd.changes === 0)
      return { applied: false,
               reason: fenceSlice && task.slice_cursor !== slice ? "stale-slice" : "lost-race" };

    const { seq } = db.prepare(
      `INSERT INTO phase_event(task,at,op,from_phase,to_phase,from_generation,to_generation,slice,artifact_sha,detail)
       VALUES(?,unixepoch(),?,?,?,?,?,?,?,?) RETURNING seq`)
      .get(taskId, op, expectedPhase, decision.to, expectedGeneration, decision.generation,
           slice, artifactSha, JSON.stringify({
             // The merge witness rides in `detail`. `nextPhase` refuses
             // `slice.merged` without these, and then the durable event recorded
             // only the evidence KIND -- so the record said the task reached
             // SLICE_MERGED with nothing naming the merge that authorised it.
             ...(evidence?.kind === "slice.merged"
               ? { mergedSha: evidence.mergedSha, mergedAt: evidence.mergedAt } : {}),
             evidence: evidence?.kind ?? null,
             // The CLAIMING witness, durable, for the same reason.
             ...(evidence?.kind === "claim.won"
               ? { claimEventId: evidence.claimEventId,
                   projectionGeneration: evidence.projectionGeneration }
               : {}) }));

    // ...and onto the task row, which is what `task why` and the merge pre-flight
    // read. The event is the log; the columns are the projection.
    if (evidence?.kind === "claim.won")
      db.prepare("UPDATE task SET claim_event_id=?, projection_generation=? WHERE id=?")
        .run(evidence.claimEventId, evidence.projectionGeneration, taskId);

    // The transition LOG needs its own row image, or replay restores the task
    // projection and loses every transition after the snapshot -- and restored
    // outbox rows keep fence values pointing at phase_event seqs that no longer
    // exist, so fence revalidation compares against nothing.
    hubEvent(db, { kind: "phase_event.appended", task: taskId,
      payload: db.prepare(`SELECT seq, task, at, op, from_phase, to_phase, from_generation,
                                  to_generation, slice, artifact_sha, detail
                           FROM phase_event WHERE seq = ?`).get(seq) });

    // THREE PHASES, in this order, and the ordering is the whole contract:
    //
    //   1. `void-pending` -- alone, first, before anything new exists.
    //   2. the caller's `effects`.
    //   3. every remaining compensation, ending with `record-drain`.
    //
    // Anything else loses effects. `void-pending` voids `cancellable=1 AND
    // status='pending'`, and every effect enqueued here is cancellable and
    // pending by default -- so enqueueing the caller's effects first voids them
    // immediately and leaves them out of `record-drain`'s snapshot: the task
    // reaches CANCELLED with its own close and comment effects never performed
    // and no drain row naming them. Running `record-drain` early loses the other
    // half, for the mirror reason.
    for (const c of decision.compensations.filter(c => c === "void-pending"))
      applyCompensation(db, { c, taskId, generation: decision.generation, seq, evidence, snapshot: evidence?.snapshot });
    for (const e of effects)
      enqueueEffect(db, { ...e, taskId, generation: decision.generation, fence: seq });

    if (decision.persistDepth) persistDepth(db, taskId, decision.persistDepth, depthEventFor(evidence));

    // Phase 3. `void-pending` is SKIPPED here: it ran in phase 1, and running it
    // again would void the effects phase 2 just enqueued -- the exact failure the
    // ordering exists to prevent, reintroduced by the fix for it.
    for (const c of decision.compensations) {
      if (c === "void-pending") continue;
      // `holdReason`, not the raw evidence: a post-approval `depth.override`
      // carries no `reason`, so `record-hold-reason` would insert a NULL into a
      // NOT NULL column and roll the whole override back. The value was derived
      // above and then not handed to the thing that needs it.
      applyCompensation(db, { c, taskId, generation: decision.generation, seq,
                              evidence: { ...evidence, reason: evidence?.reason ?? holdReason },
                              snapshot: evidence?.snapshot });
    }

    // resume_seq is bumped BEFORE the event is built, and travels IN it. Bumping
    // it afterwards means the replayed payload carries the old counter -- and a
    // re-minted SPEC_DRAFT round then reuses an earlier resume's idempotency key.
    const resumeSeq = task.resume_seq + (evidence?.kind === "founder.resume" ? 1 : 0);
    if (resumeSeq !== task.resume_seq)
      db.prepare("UPDATE task SET resume_seq=? WHERE id=?").run(resumeSeq, taskId);

    // The payload is a ROW IMAGE, so it carries every column the UPDATE wrote --
    // replay upserts exactly the columns listed and leaves the rest at whatever
    // the snapshot held. Read back out of the row rather than recomputed, so the
    // image cannot drift from the update. The CONTRACT columns are in it
    // unconditionally: `adopt-snapshot` writes all eleven in this same
    // transaction, and a conditional image is a second thing that can drift.
    const wrote = db.prepare(`SELECT id, phase, generation, resume_seq, slice_cursor,
                                     held_from, blocked_reason, terminal_reason,
                                     claim_event_id, projection_generation,
                                     repo_id, nwo_snapshot, repo_path, profile_path, profile_hash,
                                     default_branch, visibility, spec_repo_id,
                                     gate_definition_hash, registry_version, founder_user_id,
                                     updated_at
                              FROM task WHERE id=?`).get(taskId);
    hubEvent(db, { kind: "task.transitioned", task: taskId, payload: wrote });

    if (decision.escalate) {
      // `bt:<id>`, not `<id>`. A task id is ALREADY `bt:1`, so substituting the
      // bare placeholder produces `bt:bt:1:infeasible` -- a key that matches
      // nothing the announcer or `task resolve` knows, so the escalation is
      // raised into a namespace nobody reads.
      const why = decision.escalate.replace("bt:<id>", taskId);
      db.prepare(`INSERT INTO escalation(why,count,first_seen_at,last_seen_at,announced_count)
                  VALUES(?,1,unixepoch(),unixepoch(),0)
                  ON CONFLICT(why) DO UPDATE SET count=count+1, last_seen_at=unixepoch()`).run(why);
      // The ROW, not the key: `{ why }` alone loses the counters and timestamps
      // this statement just changed, so the log records that an escalation
      // happened and not what the escalation now says.
      hubEvent(db, { kind: "escalation.raised", task: taskId,
        payload: db.prepare("SELECT why, count, first_seen_at, last_seen_at, announced_count FROM escalation WHERE why = ?").get(why) });
    }
    return { applied: true, to: decision.to, generation: decision.generation, seq };
  });
}
