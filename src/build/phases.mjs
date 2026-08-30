// phases -- the transition matrix, and nothing else.
//
// Pure and total, and it imports nothing. No database, no clock, no
// filesystem, no randomness: the model reasons inside a phase worker, and this
// module decides what a phase change MEANS. Keeping it pure is what makes the
// matrix testable as a table rather than as a fixture ceremony.
//
// Total matters more than it looks. A machine with a hole does not fail at the
// hole -- it returns nothing, the caller reads that as "no transition", and the
// task sits in a state forever with nothing reporting it. Every (phase,
// evidence) pair therefore returns either a transition or a REASONED refusal,
// and `transition.refused` is logged: absence is never success.
export const ACTIVE = Object.freeze([
  "FILED","CLAIMING","SIZING","RESEARCH","DESIGN","SPEC_DRAFT","SPEC_PR_OPEN","GATE",
  "APPROVED","IMPLEMENTING","IMPL_PR_OPEN","VERDICT_WAIT","SLICE_MERGED","FINALIZING"]);
// The phases the implementation LOOP returns to. A task at slice 1 occupies the
// same phase, under the same generation, that it occupied for slice 0 -- so a
// report about one of these says nothing about WHICH slice unless it names one,
// and the transition applier requires it. Exported because the applier is where
// the requirement is enforced and this is where the fact lives.
export const SLICE_SCOPED = Object.freeze(
  ["IMPLEMENTING","IMPL_PR_OPEN","VERDICT_WAIT","SLICE_MERGED"]);

// The phases a worker is DISPATCHED for, and the action name each is dispatched
// under. Two vocabularies for the same three things, and they do not match by
// rule: `SIZING` dispatches as `BUILD_SIZE`, not `BUILD_SIZING`. A
// `BUILD_${phase}` derivation is therefore wrong for one of the three -- the
// kind of near-miss that makes a "derived" list quietly incorrect for exactly
// one entry, which is worse than an honest map.
//
// So the mapping is written out, and the half that CAN be checked is: the test
// asserts every KEY here is a real phase from ACTIVE, so a typo does not become
// a fourth valid-looking action nobody dispatches.
//
// IT LIVES HERE because two places need it and neither should own it. The
// profile schema validates `builder.budgets`, whose keys are these action names
// and which must refuse one that has no phase; the dispatcher reaches them at
// `sandboxFor` and `promptFor`. Declared in either of those, the other would
// write the same three strings again -- and a second inventory of three names
// that agree today is the defect this codebase keeps finding.
export const BUILD_ACTION_FOR = Object.freeze({
  SIZING:   "BUILD_SIZE",
  RESEARCH: "BUILD_RESEARCH",
  DESIGN:   "BUILD_DESIGN",
});
export const BUILD_ACTIONS = Object.freeze(Object.values(BUILD_ACTION_FOR));

/**
 * Is this transition ABOUT a slice, rather than merely happening during one?
 *
 * Both halves are needed. The PHASE alone is too broad: a hold, a cancel or a
 * depth override from IMPLEMENTING is about the TASK, and demanding a slice
 * number from them refuses ordinary transitions that have no slice to name. The
 * EVIDENCE alone is too narrow in the other direction, since `phase.succeeded`
 * means something different outside the loop.
 *
 * These three are the reports that advance the slice pipeline, and they are the
 * ones a delayed duplicate can misapply to the slice that came after.
 */
export const isSliceReport = (phase, kind) =>
  SLICE_SCOPED.includes(phase) &&
  (kind === "slice.merged" || kind === "slice.next" || kind === "phase.succeeded");
export const HELD     = Object.freeze(["BLOCKED","ESCALATED"]);
export const DRAINING = Object.freeze(["CANCELLING"]);
export const TERMINAL = Object.freeze(["DONE","CANCELLED","LOST","INFEASIBLE"]);
export const PHASES   = Object.freeze([...ACTIVE, ...HELD, ...DRAINING, ...TERMINAL]);

/**
 * "Any non-terminal" in section 3.1 means every state except the four
 * terminals AND except CANCELLING. CANCELLING is a source for nothing: it
 * exits only to CANCELLED. Spelling that out here rather than at each edge is
 * what stops one edge from quietly forgetting it.
 */
export const NON_TERMINAL = Object.freeze(PHASES.filter(p => !TERMINAL.includes(p) && p !== "CANCELLING"));

const WORKER_PHASES = Object.freeze(["SIZING","RESEARCH","DESIGN","SPEC_DRAFT","IMPLEMENTING"]);

// The linear spine. Read this against section 3.1's diagram directly.
const ADVANCE = {
  FILED: "SIZING", SIZING: "RESEARCH", RESEARCH: "DESIGN",
  DESIGN: "SPEC_DRAFT", SPEC_DRAFT: "SPEC_PR_OPEN", SPEC_PR_OPEN: "GATE",
  APPROVED: "IMPLEMENTING", IMPLEMENTING: "IMPL_PR_OPEN", IMPL_PR_OPEN: "VERDICT_WAIT",
};
// CLAIMING is deliberately absent from the spine: it leaves only on claim.won or
// claim.lost, both of which carry evidence a phase report does not have.
//
// `phase.succeeded` consults ADVANCE[phase] as its fallback, so listing CLAIMING
// here would advance a bare `{kind:"phase.succeeded", phase:"CLAIMING"}` straight
// to SIZING and never reach the claim.won branch -- defeating the guard that
// refuses a claim without a ledger event id and a projection generation. A
// comment asserting an absence is not an absence; the matrix test asserts it.
//
// VERDICT_WAIT and FINALIZING are deliberately ABSENT for the same kind of
// reason. VERDICT_WAIT leaves only on the reconciler's `slice.merged` witness --
// a real mergedAt read back from GitHub -- so on the spine any misrouted phase
// completion would move a task to SLICE_MERGED with nothing merged. FINALIZING
// leaves only when every enqueued effect has settled (section 9.7: the ledger
// write-back, the completion comment, the PR close, the lease cleanup); a task
// that reached DONE with those outstanding would be terminal with externally
// visible work still in flight, and DONE has no edges out.

// A refusal may still carry state the caller must persist: a depth override that
// does not change the phase is still an accepted override, and discarding it
// would leave the promised redispatch with nothing new to dispatch under.
const refuse = (refusal, extra = {}) => ({ ok: false, refusal, ...extra });

// One identity per hold cause, section 11.7. The keys are exactly `pr_hold`'s
// CHECK set minus the two that never arrive as a `hold` (`cancel` is CANCELLING,
// `escalated` is the exhausted-retries edge), so the map is closed against the
// schema rather than against memory. `<id>` is substituted by applyTransition.
// EXPORTED: transition.mjs indexes this map in the stacked-hold branch, and a
// second copy there would be a second closed set to drift from the DDL.
export const HOLD_ESCALATION = Object.freeze({
  ownership_lost:      "bt:<id>:intake:ownership-lost",
  harness_touched:     "bt:<id>:impl:harness-touched",
  over_budget:         "bt:<id>:impl:over-budget",
  depth_post_approval: "bt:<id>:depth:post-approval",
  reopen:              "bt:<id>:spec:reopened",
  blocked_other:       null,          // supplied by the caller; see the hold branch
});

/**
 * A hold_reason -> the `pr_hold.reason` the DDL admits.
 *
 * Exported because `applyTransition`'s stacked-hold branch writes that column
 * and had no way to derive the value. The two sets are nearly the same and NOT
 * identical -- `pr_hold` also admits `cancel` and `escalated`, which no hold
 * reason produces -- so the mapping is written out rather than assumed to be
 * the identity, and an unknown reason throws here rather than reaching the CHECK.
 */
export const holdReasonFor = (reason) => {
  if (!Object.prototype.hasOwnProperty.call(HOLD_ESCALATION, reason))
    throw new Error(`no pr_hold reason for hold reason ${JSON.stringify(reason)}`);
  return reason;                     // the hold-reason names are a subset of pr_hold's
};

// The reason check has to run on BOTH hold paths, not only the one that
// transitions. An already-held task takes the generic "already held" refusal
// first, and applyTransition's stacking branch then writes `evidence.reason`
// straight into hold_reason's closed CHECK -- so an unknown reason would THROW
// inside the transaction instead of returning a reasoned refusal, and a
// `blocked_other` with no escalation identity would stack a hold that reaches
// nobody. One validator, called from both.
const holdReasonRefusal = (evidence) => {
  if (!Object.prototype.hasOwnProperty.call(HOLD_ESCALATION, evidence?.reason))
    return `unknown hold reason ${JSON.stringify(evidence?.reason)}; ` +
           `it must be one of ${Object.keys(HOLD_ESCALATION).join(", ")}`;
  // `blocked_other` is the catch-all the DDL gives a `detail` column for; the
  // caller that knows the cause supplies the identity.
  // NONEMPTY, not merely non-null. The downstream raise is `if
  // (decision.escalate)`, so an empty or whitespace-only string is falsy there
  // and no escalation is raised at all -- the task enters BLOCKED with no
  // founder-visible identity, which is precisely what this validator exists to
  // refuse. A null check alone was one shape short of its own stated purpose.
  if (evidence.reason === "blocked_other" && String(evidence.escalation ?? "").trim() === "")
    return "a blocked_other hold must carry the escalation identity for its cause; " +
           "a hold with no identity reaches no founder";
  return null;
};

// The depths section 5 defines. Closed, so an override to a name nobody
// implements is refused rather than persisted and dispatched under.
const DEPTHS = Object.freeze(["trivial", "standard", "deep"]);

/**
 * The COMPLETE section 1.5 admission snapshot.
 *
 * Exported because ADMISSION needs the same list. `admitTask` wrote
 * `specRepoId`, `gateDefinitionHash` and `founderUserId` straight through, and
 * all three columns are nullable -- so a snapshot whose lookups returned null
 * was accepted, and the task acquired its territory and entered FILED unable to
 * create or gate its spec PR, or to authenticate the founder comment overrides
 * section 5 authorises against that immutable identity. Regeneration already
 * refused exactly that shape; the list lived inside its branch, so admission
 * could not consult it.
 *
 * A partial snapshot is the failure that looks like success: the columns it does
 * carry are correct.
 */
export const SNAPSHOT_FIELDS = Object.freeze(
  ["repoId", "nwo", "repoPath", "profilePath", "profileHash",
   "defaultBranch", "visibility", "specRepoId",
   "gateDefinitionHash", "registryVersion", "founderUserId"]);

export const missingSnapshotFields = (snapshot) =>
  SNAPSHOT_FIELDS.filter(f => snapshot?.[f] == null);

const go = (to, { generation, bumps = false, compensations = [], sliceCursor = null,
                  escalate = null, persistDepth = null }) =>
  ({ ok: true, to, generation, bumps, sliceCursor, escalate, persistDepth,
     compensations: Object.freeze(compensations) });

export function nextPhase(state, evidence) {
  // `sliceCursor` is READ by the SLICE_MERGED branch below, which advances it
  // past the slice that just merged. Left out of this destructuring it is not
  // undefined but unbound, so that branch throws a ReferenceError -- and the
  // totality matrix reports it as a hole rather than as the crash it is.
  const { phase, generation = 1, heldFrom = null, drainRemaining = 0,
          hasOpenPr = false, pinnedTerritory = false, sourceKind = "founder",
          hasLiveRun = false, sliceCursor = 0, drainBeforeStop = 0 } = state ?? {};
  const kind = evidence?.kind;

  if (!PHASES.includes(phase)) return refuse(`unknown phase ${JSON.stringify(phase)}`);
  if (TERMINAL.includes(phase)) return refuse(`${phase} is terminal; no evidence moves it`);

  // CANCELLING first, because it is the one state whose answer to almost
  // everything is no, and reading that as a special case at each edge below is
  // how the exclusion gets forgotten.
  if (phase === "CANCELLING") {
    if (kind === "drain.settled")
      return drainRemaining > 0
        ? refuse(`${drainRemaining} row(s) still draining; CANCELLED is not legitimate until every one reconciles`)
        : go("CANCELLED", { generation, compensations: ["release-territory"] });
    if (kind === "founder.cancelForce") {
      // drainEligible is the caller's read; applyTransition re-derives it from
      // the CANCELLING entry timestamp inside the transaction before committing,
      // for the same reason FINALIZING re-counts its effects: this is a terminal
      // transition and the machine cannot see a clock.
      //
      // Section 3.5 permits --force only after builder.cancel.drainMinutes has
      // passed. Without that guard a founder can force a cancel one second in,
      // recording rows as `forced` whose reconcilers had not been tried even
      // once -- the one terminal transition whose external truth was never
      // confirmed, made available before anything was attempted.
      if (!evidence.drainEligible)
        return refuse("cancel --force is available only after builder.cancel.drainMinutes has passed; " +
                      "the drain has not yet had its window");
      // force-drain records what was NOT confirmed, rather than leaving the
      // projection claiming the effects are still unresolved while the task is
      // terminal. It sets task_drain.forced with the last reconciler attempt in
      // last_known, and moves the matching outbox rows to the hub-only status
      // `forced` so the executor stops recovering them under a CANCELLED task.
      return go("CANCELLED", { generation, compensations: ["force-drain","release-territory"] });
    }
    return refuse(`CANCELLING exits only to CANCELLED; it is not a source for ${kind}`);
  }

  // Founder verbs available from every non-terminal state.
  if (kind === "founder.cancel")
    return go("CANCELLING", { generation,
      // The order is the contract. `void-pending` FIRST: it voids
      // `cancellable=1 AND status='pending'`, and every effect the cancellation
      // itself enqueues is created cancellable and pending -- run later it would
      // void its own new rows, they would be absent from `record-drain`'s
      // snapshot, and CANCELLED would be reachable with the close and comment
      // effects never performed. `record-drain` LAST: it snapshots what is
      // outstanding at that moment, so anything that ENQUEUES must precede it.
      compensations: ["void-pending","close-prs","release-territory",
                      // A ledger claim that already LANDED is not undone by
                      // draining: another actor must be able to take the node.
                      // Derived from the task's own SOURCE rather than from an
                      // optional field a caller may simply have omitted --
                      // `release-ledger-claim` enqueues `--if-owner`, which is
                      // inert when reeve does not own it, so emitting it for
                      // every ledger-sourced cancellation is the safe direction.
                      ...(sourceKind === "ledger" ? ["release-ledger-claim"] : []),
                      // A live phase worker keeps consuming provider capacity and
                      // writing to its worktree after the cancel commits.
                      "terminate-worker",
                      ...(hasOpenPr ? ["write-pr-hold"] : []), "record-drain"] });

  if (kind === "founder.infeasible") {
    // INFEASIBLE is a success state, but never a quiet one: its entry raises
    // bt:<id>:infeasible so the founder reads WHY work stopped. A terminal state
    // with no durable explanation cannot be explained afterwards -- there are no
    // edges out and no later phase to record it.
    if (!evidence.reason || !String(evidence.reason).trim())
      return refuse("infeasible requires a reason; a terminal state with no explanation cannot be explained later");
    // INFEASIBLE from IMPL_PR_OPEN or VERDICT_WAIT leaves an open builder PR
    // behind. Without a hold the guardian's verdict has nothing to read, the
    // required check stays green at the head, and a PR belonging to a task that
    // was declared infeasible remains mergeable until its close effect settles.
    // The hold is the part that does not depend on an effect settling.
    return go("INFEASIBLE", { generation, escalate: `bt:<id>:infeasible`,
      // `record-drain` LAST for the same reason as cancel: an effect leased when
      // this commits settles under the unchanged generation, and INFEASIBLE has
      // no later phase to record it. `void-pending` clears the QUEUED ones; the
      // drain is for the ones already in flight, which is a different set.
      compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                      "void-pending","close-prs","release-territory",
                      ...(hasOpenPr ? ["write-pr-hold"] : []), "record-drain"] });
  }

  // Held states: exactly one exit verb each, and a hold that arrives while
  // already held STACKS rather than transitioning -- a transition here would
  // rewrite held_from and lose where the task goes back to.
  if (HELD.includes(phase)) {
    if (kind === "hold") {
      // Validate FIRST. The refusal below is the one applyTransition turns into
      // a durable stacked write, so reaching it with an unvalidated reason hands
      // the closed CHECK a name it will throw on.
      const bad = holdReasonRefusal(evidence);
      if (bad) return refuse(bad);
      // `stackable` is what applyTransition keys the stacking branch on.
      // Re-deriving it from (phase is HELD && kind === "hold") is true of a
      // REFUSED reason too -- so the branch that writes the hold row would run
      // for exactly the refusals that must not write one.
      return refuse(`${phase} is already held; stack a hold_reason and keep the original held_from`,
                    { stackable: true });
    }
    if (kind === "founder.resume") {
      // Entering a held state RELEASED the territory (section 3.4), so another
      // task may legitimately hold an overlapping path by now. The machine stays
      // pure, so the caller supplies the answer -- but applyTransition RE-RUNS
      // the intersection check inside its transaction before granting the lease
      // (see `regrant-territory`). Trusting a value computed before
      // BEGIN IMMEDIATE would let a filing that landed in between hold both claims.
      if (evidence.territoryConflict)
        return refuse(`territory now conflicts with ${evidence.territoryConflict}; ` +
                      `resume is refused until the founder settles who owns it`);
      // AND THE DRAIN THE HOLD LEFT BEHIND. Entering BLOCKED or ESCALATED runs
      // `record-drain`, which snapshots the effects that were still in flight --
      // a push, a PR operation, a merge -- and those settle under the UNCHANGED
      // generation, because a hold does not bump it. An immediate resume clears
      // the holds and puts the task back to work beside them: two writers on one
      // branch, and a merge that lands for a task that has since been redesigned.
      //
      // `drainRemaining` is already computed for CANCELLING, which refuses
      // CANCELLED until it reaches zero. The same count answers the same question
      // here and this branch simply never read it, so the drain protected the
      // cancellation path and not the resume path -- the one a founder actually
      // reaches for, and reaches for quickly.
      // `drainBeforeStop`, not `drainRemaining`. The hold's OWN explanatory
      // comment is in the full count -- `record-drain` runs last precisely so it
      // snapshots the compensations too, which CANCELLING needs -- and counting
      // it here refused every hold-then-resume until something delivered a
      // comment. The question a resume asks is whether the work the task was
      // DOING is still in flight.
      if (drainBeforeStop > 0)
        return refuse(`${drainBeforeStop} effect(s) from the hold are still draining; ` +
                      `they settle under this generation and would run beside the resumed task. ` +
                      `Resume once they reconcile, or cancel if they never will`);
      // Section 3.4 requires TWO preconditions on resume, not one. A task held
      // because ownership was lost is precisely the case where the second
      // matters: territory can be free while a human still owns the ledger node,
      // and resuming then puts reeve back to work on someone else's task.
      //
      // AFFIRMATIVE, not negative-only. Testing only `evidence.ownerNotReeve`
      // refuses a caller that checked and found a human, and admits a caller
      // that never checked at all -- and the second is the likelier bug, because
      // omitting an optional field is what a forgetful caller does.
      //
      // Scoped by source kind: founder-filed tasks have no ledger owner, and
      // section 2.5 puts them out of scope explicitly rather than by omission.
      if (sourceKind === "ledger") {
        if (evidence.ownerNotReeve)
          return refuse(`the ledger still projects ${evidence.ownerNotReeve} as owner; ` +
                        `resume is refused until reeve's claim is re-established`);
        if (evidence.ownerIsReeve !== true || evidence.ownershipSyncedAt == null)
          return refuse("a ledger-sourced resume needs a full ledger sync showing reeve as owner; " +
                        "pass ownerIsReeve and ownershipSyncedAt from that sync, or the resume is " +
                        "restarting work on a claim nobody re-verified");
        // FRESH, not merely present. A non-null `ownershipSyncedAt` says a sync
        // happened at some point, which stays true forever after the first one --
        // so a task could be resumed on a witness from last week even though a
        // human has taken the node since, which is the exact case the witness
        // exists to rule out. The machine has no clock by design, so the bound
        // and the current time arrive as evidence, the same way `drainMinutes`
        // does for the force window. A missing bound REFUSES rather than
        // defaulting: a default here is an invented freshness, and this guard
        // exists precisely because "recent enough" cannot be guessed.
        if (evidence.ownershipMaxAgeSeconds == null || evidence.now == null)
          return refuse("a ledger-sourced resume needs the ownership freshness bound and the command time; " +
                        "the machine has no clock and cannot invent one");
        if (evidence.now - evidence.ownershipSyncedAt > evidence.ownershipMaxAgeSeconds)
          return refuse(`the ownership witness is ${Math.floor((evidence.now - evidence.ownershipSyncedAt) / 60)}m old ` +
                        `and the bound is ${Math.floor(evidence.ownershipMaxAgeSeconds / 60)}m; re-sync before resuming`);
      } else if (evidence.ownerNotReeve) {
        // A founder-filed task carrying an owner is a caller error, not a
        // silently ignored field.
        return refuse(`a founder-filed task has no ledger owner; ` +
                      `${evidence.ownerNotReeve} cannot be projected for it`);
      }
      if (evidence.redesign)
        // sliceCursor 0, because a REDESIGN is a new plan. The cursor is durable
        // and a generation bump left it alone, so a task held after finishing
        // slices 0..N-1 re-entered IMPLEMENTING at slice N under a design whose
        // slice N is different work -- skipping the first N slices of the new
        // plan entirely, with the phase machine agreeing that everything before
        // them was done. The old slices belong to the old generation, and the new
        // generation has never implemented anything.
        // `clear-holds-except-closing`, NOT `clear-holds`. A redesign clears every
        // hold and then merely ENQUEUES the close -- so between the two, an
        // abandoned implementation PR is open with no guardian-visible hold. If
        // the close is delayed, retried, or refused because `publishPr` is off,
        // its next verdict goes GREEN and a human or a stale client can merge
        // work from a design that has been superseded. The hold is what makes a
        // stopped PR unmergeable, and it must outlive the decision to close it.
        //
        // The spec PR's hold IS cleared: it is reused, this transition pushes a
        // new head to it, and it is meant to be workable again.
        return go("DESIGN", { generation: generation + 1, bumps: true, sliceCursor: 0,
          compensations: ["clear-holds-except-closing","annotate-resumed","regrant-territory",
                          ...(hasOpenPr ? ["close-prs"] : [])] });
      if (!heldFrom) return refuse(`${phase} has no held_from recorded; resume cannot know where to re-enter`);
      return go(heldFrom, { generation, compensations: ["clear-holds","annotate-resumed","regrant-territory"] });
    }
    return refuse(`${phase} is held; its only exit is reeve task resume`);
  }

  // A hold from any active state. `record-hold-reason` is here because the
  // already-held branch is the only one that inserts one otherwise: without it
  // the FIRST hold on a task records no reason at all, so `task resume` lists
  // the stacked reasons and silently drops the original.
  //
  // A live --pin-territory survives BLOCKED exactly as it survives ESCALATED:
  // section 10.2 makes the exception apply to BOTH held states. Releasing a
  // pinned lease here lets an overlapping filing take territory the founder
  // explicitly reserved, and `resume` then refuses naming a blocker the founder
  // created by pinning.
  if (kind === "hold") {
    // Every hold cause has a founder-visible identity in section 11.7. BLOCKED
    // has no automatic exit, so an unannounced hold is a task that stops and
    // waits for a founder who was never told. The same validator the already-held
    // path calls, so the two cannot drift.
    const badReason = holdReasonRefusal(evidence);
    if (badReason) return refuse(badReason);
    const escalate = evidence.reason === "blocked_other"
      ? evidence.escalation
      : HOLD_ESCALATION[evidence.reason];
    return go("BLOCKED", { generation, escalate,
      // `record-drain` LAST here too. `void-pending` reaches only the QUEUED
      // rows; an effect already INFLIGHT when the hold lands is untouched by it,
      // and section 3.2 requires a BLOCKED entry to record the in-flight set.
      // Without a drain row the task can be resumed while that effect is still
      // resolving, with nothing for diagnostics, replay or settlement to key on.
      compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                      "record-hold-reason","void-pending",
                      ...(pinnedTerritory ? [] : ["release-territory"]),
                      // The durable hold AND the human-readable one. `pr_hold` is
                      // what the guardian reads to render BLOCK; it says nothing
                      // to the people on the pull request, who see work simply
                      // stop. A later resume then posts a `resumed` comment with
                      // no matching hold comment before it -- a thread that
                      // announces the end of something it never announced the
                      // start of. Only the HOLD paths: cancel and infeasible
                      // close their PRs and already post a close notice, so a
                      // hold comment there would explain a stop that is really
                      // an ending.
                      ...(hasOpenPr ? ["write-pr-hold","annotate-held"] : []),
                      "record-drain"] });
  }

  // A worker phase whose bounded retries are exhausted. ESCALATED voids
  // NOTHING -- the phase merely stopped and its effects stand -- but it does
  // release the territory, because a provider failure waiting on a founder
  // must not starve every overlapping task for as long as the founder is away.
  if (kind === "phase.failed") {
    if (!evidence.retriesExhausted) return refuse("retries remain; this is a new attempt, not a transition");
    if (!WORKER_PHASES.includes(phase)) return refuse(`${phase} is not a worker phase; it has no attempt budget`);
    // The escalation identity is minted HERE, where the phase is known. Without
    // it the task stops with no durable founder notification -- a worker that ran
    // out of attempts and a worker that is still trying look identical from
    // outside. `<id>` stays a placeholder because applyTransition substitutes the
    // task id; `<phase>` cannot, because only the machine knows it.
    // AN ESCALATION IS A STOP, so it gets the same durable pre-stop accounting
    // every other stop gets. Without `void-pending` a cancellable effect from
    // before the escalation stays deliverable, and `stillDeliverable` only
    // fences it while the task is still ESCALATED -- so whether the external
    // action happened came down to whether an executor reached the row before
    // the founder resumed. And without `record-drain` there is no record of what
    // was INFLIGHT when it stopped, which `void-pending` cannot reach and which
    // a resume must not run beside. `record-drain` LAST, so it snapshots the
    // compensations too.
    return go("ESCALATED", { generation, escalate: `bt:<id>:phase:failed:${phase}`,
      compensations: ["void-pending",
                      ...(hasOpenPr ? ["write-pr-hold"] : []),
                      ...(pinnedTerritory ? [] : ["release-territory"]),
                      "record-drain"] });
  }

  // CLAIMING leaves on a claim-specific witness, never the generic spine. The
  // claim's proof is durable provenance -- the ledger event id and the
  // projection generation the claim was made against (section 2.1) -- and a
  // generic phase.succeeded carries neither, so a misrouted report would move a
  // task into SIZING with no record of what it claimed or against which
  // projection. applyTransition persists both from this evidence.
  if (phase === "CLAIMING" && kind === "claim.won") {
    if (!evidence.claimEventId || evidence.projectionGeneration == null)
      return refuse("claim.won without a ledger event id and projection generation is not a claim witness");
    return go("SIZING", { generation });
  }
  // LOST voids like every other terminal path. A task that lost the claim race
  // has pending effects enqueued during CLAIMING; leaving them pending means the
  // executor performs them for a task that never owned the work -- the ledger
  // claim being the one that matters, since another actor now holds it.
  if (phase === "CLAIMING" && kind === "claim.lost")
    // `record-drain` LAST, as on every other terminal path. An effect already
    // LEASED when this commits still settles under the unchanged generation, and
    // with no drain row the hub has no record it was outstanding and no
    // last-known outcome for `task why`. LOST is terminal: no later phase notices.
    return go("LOST", { generation,
      compensations: ["void-pending","release-territory","record-drain"] });

  if (phase === "GATE") {
    if (kind === "gate.approved")    return go("APPROVED", { generation });
    if (kind === "gate.revise")      return go("SPEC_DRAFT", { generation });
    // A task at the revision cap necessarily has an open SPEC PR -- that is what
    // the rounds were spent on -- so this edge holds it like every other path
    // into a held state. The cap is a founder-held stop, and section 11.7 names
    // the identity for it: fail-closed must never mean fail-quiet.
    // The same durable accounting as every other stop, for the same reason.
    if (kind === "gate.capReached")  return go("ESCALATED", { generation,
      escalate: `bt:<id>:gate:revision-loop`,
      compensations: ["void-pending", "write-pr-hold",
                      ...(pinnedTerritory ? [] : ["release-territory"]),
                      "record-drain"] });
    // depth.override from GATE is handled by the shared block below, so the two
    // cannot drift apart.
  }

  // A depth override before APPROVED re-dispatches; after APPROVED it holds, and
  // the founder's choice of resume or resume --redesign decides.
  //
  // "Re-dispatches" means the phase runs AGAIN under the new depth, not that the
  // task jumps forward. Section 5: before APPROVED nothing is bound yet, and the
  // override changes that phase's budget and fan-out. Sending SIZING straight to
  // DESIGN would skip sizing that never finished under the new depth; sending
  // RESEARCH there would discard the research the new depth just asked for.
  // Only the phases whose OUTPUT is already written go back to DESIGN, which is
  // exactly the three edges section 3.1 draws (SPEC_DRAFT, SPEC_PR_OPEN, GATE).
  if (kind === "depth.override") {
    // `persistDepth` travels on BOTH shapes: a refusal here means "the phase does
    // not change", not "the override is discarded". Without it the
    // SIZING/RESEARCH/DESIGN branch promises a redispatch under a new depth and
    // records no new depth to dispatch under.
    if (!DEPTHS.includes(evidence.depth))
      return refuse(`unknown depth ${JSON.stringify(evidence.depth)}; it must be one of ${DEPTHS.join(", ")}`);
    if (WORKER_PHASES.includes(phase) && ["SIZING","RESEARCH","DESIGN"].includes(phase))
      return refuse(`${phase} re-dispatches under the new depth as a new attempt; the phase does not change`,
                    { persistDepth: evidence.depth,
                      // The re-dispatch is a NEW attempt, so the old one has to
                      // end. This branch refuses the transition, so it cannot use
                      // `go`'s compensations -- and without them the previous
                      // worker keeps running under the old depth's budget and
                      // fan-out while the new attempt is dispatched beside it,
                      // which is the one outcome an override must not produce.
                      compensations: hasLiveRun ? ["terminate-worker"] : [] });
    if (["SPEC_DRAFT","SPEC_PR_OPEN","GATE"].includes(phase))
      return go("DESIGN", { generation, persistDepth: evidence.depth,
        // The running worker is mid-flight under the OLD depth's budget and
        // fan-out, and the new depth is the whole point of the override. Left
        // alone it keeps spending and keeps writing its artifact, and the
        // re-dispatch that follows either races it or never happens.
        compensations: hasLiveRun ? ["terminate-worker"] : [] });
    // Pre-SIZING is neither of the cases above, and it is not post-approval
    // either. Falling through to the hold below would move a task that has not
    // even been sized into BLOCKED and raise `depth:post-approval` -- naming an
    // approval that does not exist. Nothing is bound yet at those phases, so the
    // override is simply recorded and the task carries on.
    //
    // The exhaustive matrix cannot catch this: it accepts either a transition or
    // a refusal for every cell, so a WRONG transition reads as a legal one.
    if (["FILED", "CLAIMING"].includes(phase))
      return refuse(`${phase} has nothing sized yet; the depth is recorded and applies when SIZING starts`,
                    { persistDepth: evidence.depth });
    // Post-approval: holds, and records WHY like every other hold. The pin
    // exception applies HERE too -- an unconditional release would hand away
    // territory the founder explicitly pinned, and the resume that follows then
    // conflicts with whatever took it.
    return go("BLOCKED", { generation, escalate: `bt:<id>:depth:post-approval`,
      persistDepth: evidence.depth,
      compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                      "record-hold-reason","void-pending",
                      ...(pinnedTerritory ? [] : ["release-territory"]),
                      // The durable hold AND the human-readable one. `pr_hold` is
                      // what the guardian reads to render BLOCK; it says nothing
                      // to the people on the pull request, who see work simply
                      // stop. A later resume then posts a `resumed` comment with
                      // no matching hold comment before it -- a thread that
                      // announces the end of something it never announced the
                      // start of. Only the HOLD paths: cancel and infeasible
                      // close their PRs and already post a close notice, so a
                      // hold comment there would explain a stop that is really
                      // an ending.
                      ...(hasOpenPr ? ["write-pr-hold","annotate-held"] : []),
                      "record-drain"] });
  }

  // SLICE_MERGED must exit, or a task that merged its first slice sits there
  // forever and the totality test cannot see it: "refused" is a legal answer, so
  // a state whose every edge refuses looks total and is a dead end.
  // Which way it goes is not the machine's guess -- the loop supplies
  // `moreSlices` from the durable slice cursor and DESIGN's slice list.
  if (phase === "SLICE_MERGED") {
    if (kind === "slice.next") {
      // AN EXPLICIT BOOLEAN, because the two answers are not symmetric. `false`
      // means "the slice list was read and there are none left"; `undefined`
      // means the loop could not read the durable design artifact or the slice
      // cursor at all -- and a truthiness test spends the second as the first,
      // sending the task to FINALIZING and then DONE with every remaining
      // planned slice unimplemented. Absence is the one answer that must not
      // decide this, so it is refused rather than defaulted.
      if (typeof evidence.moreSlices !== "boolean")
        return refuse(
          "slice.next must state moreSlices as a boolean; it decides whether any planned slice " +
          "remains, and a missing value would finish the task rather than admit it is unknown");
      return evidence.moreSlices
        // The cursor is durable and nothing else writes it, so a transition back
        // to IMPLEMENTING that leaves it alone re-runs the slice that just
        // merged -- reopening or reconciling a PR that is already in.
        ? go("IMPLEMENTING", { generation, sliceCursor: sliceCursor + 1 })
        : go("FINALIZING", { generation });
    }
    if (kind === "slice.merged")
      return refuse("SLICE_MERGED is entered BY slice.merged; advancing needs slice.next");
  }

  // `reeve task regenerate` (section 4.7): the founder deliberately adopts a
  // changed contract. It bumps the generation, and re-enters at SPEC_DRAFT if the
  // task is past GATE (the spec is re-rendered under the new contract and goes
  // through the full gate again as a new head) or at the current phase otherwise.
  if (kind === "founder.regenerate") {
    if (TERMINAL.includes(phase)) return refuse(`${phase} is terminal; regenerate cannot re-open it`);
    const PAST_GATE = ["APPROVED","IMPLEMENTING","IMPL_PR_OPEN","VERDICT_WAIT","SLICE_MERGED","FINALIZING"];
    // regenerate exists to ADOPT a changed contract, so the new snapshot has to
    // be written; bumping the generation without it re-runs the phase under the
    // contract the founder just replaced, which is the opposite of the command's
    // purpose. `adopt-snapshot` writes the contract columns onto the task from
    // `evidence.snapshot`, resolved before the transaction opened -- network
    // first, transaction second, as at filing.
    //
    // The COMPLETE section 1.5 admission snapshot, not the five columns
    // `adopt-snapshot` happens to write. A regenerate that re-resolves the
    // registry and adopts only half of it leaves ONE task carrying a hybrid
    // contract -- new profile hash, old repository path -- at a generation that
    // asserts the whole thing was deliberately re-resolved. Every field is
    // required, and named, because a partial snapshot is the failure that looks
    // like success: the columns it does carry are correct. `founderUserId` is in
    // the list because comment-based depth overrides are authorised against that
    // immutable identity (section 5), so a task without it cannot authenticate
    // the very evidence this branch exists to handle.
    const missing = missingSnapshotFields(evidence.snapshot);
    if (missing.length)
      return refuse(`regenerate needs a resolved registry snapshot; missing ${missing.join(", ")}. ` +
                    `Resolve it before the transaction, as section 2.2 requires`);
    // A live worker is still writing under the OLD contract. Regenerate adopts a
    // new snapshot and bumps the generation, so a process left running produces
    // artifacts attributed to a contract that no longer exists -- and its report,
    // when it lands, is fenced and discarded, which looks like the worker failed.
    // An open implementation PR from the OLD generation is bound to a contract
    // nobody approved: it has to be held and closed like every other path that
    // abandons work, or it stays mergeable against a superseded plan.
    return go(PAST_GATE.includes(phase) ? "SPEC_DRAFT" : phase,
      // sliceCursor 0 here too, and for the same reason: `founder.regenerate`
      // adopts a CHANGED CONTRACT under a new generation, so the slices the old
      // one completed describe work the new plan does not contain.
      { generation: generation + 1, bumps: true, sliceCursor: 0,
        compensations: [...(hasLiveRun ? ["terminate-worker"] : []),
                        "adopt-snapshot","annotate-resumed",
                        ...(hasOpenPr ? ["write-pr-hold","close-prs"] : [])] });
  }

  if (kind === "phase.succeeded") {
    // The report must NAME its phase, and it must be this one. Without the check
    // a delayed or misrouted RESEARCH report advances a task that has already
    // moved to DESIGN, and the generation fence does not catch it: a stale report
    // from the same generation is exactly what an adopted worker produces after a
    // restart. Guarding only the mismatch lets a malformed bare
    // `{kind:"phase.succeeded"}` advance whatever the task currently occupies --
    // bypassing the report-to-source binding just as effectively.
    if (!evidence.phase)
      return refuse("a phase report must name the phase it came from; an unattributed success advances nothing");
    if (evidence.phase !== phase)
      return refuse(`a ${evidence.phase} report cannot advance a task in ${phase}`);
    // SIZING SELECTS THE DEPTH, so SIZING is where it becomes durable.
    //
    // The classifier's decision drives budgets, fan-out and what artifacts are
    // expected of every later phase, and `task.depth` is the only place any of
    // them can read it. Nothing wrote it on this path: `persistDepth` travelled
    // on the founder-override edges alone, so an ordinarily sized task kept
    // `depth = NULL` and no later phase could reproduce -- or even name -- the
    // decision it was working under. The skip-RESEARCH case made that sharpest:
    // the depth was consulted to skip a whole phase and then discarded.
    if (phase === "SIZING") {
      if (!DEPTHS.includes(evidence.depth))
        return refuse(
          `a SIZING report must name the depth it selected, one of ${DEPTHS.join(", ")}; ` +
          `every later budget and artifact expectation is derived from it and task.depth is ` +
          `the only record of what was chosen`);
      if (evidence.depth === "trivial")
        // The skip has to be EMITTED, not described. A plain transition to DESIGN
        // leaves no durable explanation for the absent research artifact, and the
        // gap is indistinguishable from a research phase that was lost -- which is
        // the reading that matters months later, when someone asks why this task
        // has no research to show.
        return go("DESIGN", { generation, persistDepth: evidence.depth,
                              compensations: ["record-research-skip"] });
      return go(ADVANCE.SIZING, { generation, persistDepth: evidence.depth });
    }
    if (phase === "VERDICT_WAIT")
      return refuse("VERDICT_WAIT advances only on the reconciler's slice.merged witness, never on a phase report");
    if (phase === "FINALIZING")
      return refuse("FINALIZING advances only on finalize.settled, once every enqueued effect has reconciled");
    const to = ADVANCE[phase];
    return to ? go(to, { generation }) : refuse(`${phase} has no successor on phase.succeeded`);
  }

  // The witness must be the RECONCILER's, not any caller's say-so. Section 8.6
  // makes mergedAt the evidence, so the edge requires it: without the check this
  // branch accepts a bare slice.merged and the refusal on the phase.succeeded
  // path above is trivially routed around.
  if (phase === "VERDICT_WAIT" && kind === "slice.merged") {
    if (!evidence.mergedSha || !evidence.mergedAt)
      return refuse("slice.merged without the reconciler's mergedAt and merged sha is not a merge witness");
    return go("SLICE_MERGED", { generation });
  }

  // FINALIZING is reeve code, not a worker phase: no claude session runs. It
  // exits when the loop reports every effect settled, and not before.
  if (phase === "FINALIZING" && kind === "finalize.settled")
    return evidence.outstanding === 0
      ? go("DONE", { generation, compensations: ["release-territory"] })
      : refuse(`${evidence.outstanding} finalization effect(s) still unsettled; DONE is terminal and has no way back`);

  return refuse(`no edge from ${phase} on ${kind ?? "no evidence"}`);
}
