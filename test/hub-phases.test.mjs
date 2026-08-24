// The transition matrix, as a table.
//
// This module is pure so that this test can be exhaustive rather than
// representative: every phase crossed with every evidence kind, 21 x N cells,
// each of which must return a transition or a refusal and never throw, never
// return undefined, and never invent a phase that is not in the enumeration.
//
// Totality is the property that matters. A machine with a hole does not fail
// loudly at the hole -- it returns undefined, the caller reads that as "no
// transition", and the task sits in a state forever with nothing reporting it.
import { PHASES, ACTIVE, HELD, DRAINING, TERMINAL, NON_TERMINAL, nextPhase } from "../src/build/phases.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { fail++; if (detail !== undefined) console.log(`        ${detail}`); }
};

const EVIDENCE = [
  { kind: "phase.succeeded", phase: "RESEARCH", artifactSha: "a" },
  { kind: "slice.merged" },                                   // no witness: must refuse
  { kind: "slice.merged", mergedSha: "d".repeat(40), mergedAt: 1 },
  { kind: "phase.failed", retriesExhausted: true },
  { kind: "phase.failed", retriesExhausted: false },
  { kind: "gate.approved" }, { kind: "gate.revise" }, { kind: "gate.capReached" },
  { kind: "depth.override" }, { kind: "slice.merged" }, { kind: "claim.lost" },
  { kind: "slice.next", moreSlices: true }, { kind: "slice.next", moreSlices: false },
  { kind: "claim.won" }, { kind: "claim.won", claimEventId: "e1", projectionGeneration: 3 },
  { kind: "phase.succeeded" },                              // no phase identity: must refuse
  { kind: "finalize.settled", outstanding: 0 }, { kind: "finalize.settled", outstanding: 2 },
  { kind: "founder.regenerate" },
  { kind: "hold", reason: "ownership_lost" },
  { kind: "founder.cancel" },
  { kind: "founder.cancelForce", drainEligible: true }, { kind: "founder.cancelForce", drainEligible: false },
  { kind: "founder.infeasible", reason: "r" },
  { kind: "founder.resume", redesign: false }, { kind: "founder.resume", redesign: true },
  { kind: "drain.settled" },
  { kind: "nonsense" },
];

// -- the enumeration is closed and matches the DDL ---------------------------
{
  check(PHASES.length === 21, `there are 21 phases (got ${PHASES.length})`, PHASES.join(","));
  const union = [...ACTIVE, ...HELD, ...DRAINING, ...TERMINAL].sort();
  check(JSON.stringify(union) === JSON.stringify([...PHASES].sort()),
    "active + held + draining + terminal partitions PHASES exactly", union.join(","));
  check(new Set(union).size === union.length, "and the four groups do not overlap");
  check(JSON.stringify([...HELD].sort()) === '["BLOCKED","ESCALATED"]', "the held states are exactly BLOCKED and ESCALATED");
  check(JSON.stringify(DRAINING) === '["CANCELLING"]', "CANCELLING is the only draining state");
  check(JSON.stringify([...TERMINAL].sort()) === '["CANCELLED","DONE","INFEASIBLE","LOST"]', "and the four terminals are the four terminals");
  check(!NON_TERMINAL.includes("CANCELLING"),
    "CANCELLING is NOT in NON_TERMINAL: it is excluded as a source from every 'any non-terminal' edge");
}

// -- totality: every cell answers --------------------------------------------
{
  let holes = [];
  for (const phase of PHASES) for (const e of EVIDENCE) {
    let r;
    try { r = nextPhase({ phase, generation: 2, heldFrom: "IMPLEMENTING", sliceCursor: 1, drainRemaining: 0, hasOpenPr: true }, e); }
    catch (err) { holes.push(`${phase} x ${e.kind}: threw ${err.message}`); continue; }
    if (!r || typeof r.ok !== "boolean") { holes.push(`${phase} x ${e.kind}: returned ${JSON.stringify(r)}`); continue; }
    if (r.ok && !PHASES.includes(r.to)) holes.push(`${phase} x ${e.kind}: invented phase ${r.to}`);
    if (!r.ok && !(typeof r.refusal === "string" && r.refusal.length)) holes.push(`${phase} x ${e.kind}: refusal with no reason`);
  }
  check(holes.length === 0, `every one of ${PHASES.length * EVIDENCE.length} cells returns a transition or a reasoned refusal`,
    holes.slice(0, 8).join("\n        "));

  // Totality is necessary and nowhere near sufficient: "a transition OR a
  // reasoned refusal" is satisfied by a machine that refuses every cell. The
  // legal edges have to be asserted by NAME, or an implementation can omit the
  // spine entirely and still pass.
  const EXPECTED = [
    ["FILED",        { kind: "phase.succeeded", phase: "FILED" },              "SIZING"],
    ["SIZING",       { kind: "phase.succeeded", phase: "SIZING" },             "RESEARCH"],
    ["SIZING",       { kind: "phase.succeeded", phase: "SIZING", depth: "trivial" }, "DESIGN"],
    ["RESEARCH",     { kind: "phase.succeeded", phase: "RESEARCH" },           "DESIGN"],
    ["DESIGN",       { kind: "phase.succeeded", phase: "DESIGN" },             "SPEC_DRAFT"],
    ["SPEC_DRAFT",   { kind: "phase.succeeded", phase: "SPEC_DRAFT" },         "SPEC_PR_OPEN"],
    ["SPEC_PR_OPEN", { kind: "phase.succeeded", phase: "SPEC_PR_OPEN" },       "GATE"],
    ["GATE",         { kind: "gate.approved" },                               "APPROVED"],
    ["GATE",         { kind: "gate.revise" },                                 "SPEC_DRAFT"],
    ["GATE",         { kind: "gate.capReached" },                             "ESCALATED"],
    ["APPROVED",     { kind: "phase.succeeded", phase: "APPROVED" },           "IMPLEMENTING"],
    ["IMPLEMENTING", { kind: "phase.succeeded", phase: "IMPLEMENTING" },       "IMPL_PR_OPEN"],
    ["IMPL_PR_OPEN", { kind: "phase.succeeded", phase: "IMPL_PR_OPEN" },       "VERDICT_WAIT"],
    // The SUCCESSFUL claim edge, by name. The totality loop accepts a reasoned
    // refusal as a legal answer for every cell, so a machine that refuses every
    // `claim.won` passed the whole phase suite -- and every ledger-sourced task
    // would sit in CLAIMING forever, which no other assertion here can see.
    ["CLAIMING",     { kind: "claim.won", claimEventId: "e1", projectionGeneration: 7 }, "SIZING"],
    ["CLAIMING",     { kind: "claim.lost" },                                  "LOST"],
  ];
  const wrong = EXPECTED.filter(([from, ev, to]) => {
    const r = nextPhase({ phase: from, generation: 1, heldFrom: null }, ev);
    return !(r.ok && r.to === to);
  }).map(([from, ev, to]) => `${from} --${ev.kind}--> expected ${to}`);
  check(wrong.length === 0, "every named edge of the section 3.1 spine goes where 3.1 says", wrong.join("; "));
}

// -- terminals are terminal --------------------------------------------------
{
  const escapes = [];
  for (const phase of TERMINAL) for (const e of EVIDENCE) {
    const r = nextPhase({ phase, generation: 1 }, e);
    if (r.ok) escapes.push(`${phase} -> ${r.to} on ${e.kind}`);
  }
  check(escapes.length === 0, "no evidence of any kind moves a terminal state", escapes.join(", "));
}

// -- the named edges from the Verify clause ----------------------------------
{
  // regenerate emits adopt-snapshot, which writes the contract columns from
  // evidence.snapshot. Without the snapshot it bumped the generation and then
  // adopted undefined into every one of them. ALL ELEVEN fields the validation
  // requires, so the block advertised as the successful control really is one.
  const SNAP = { repoId: 1, nwo: "o/r", repoPath: "/p", profilePath: "/f",
                 profileHash: "h", defaultBranch: "main", visibility: "private",
                 specRepoId: 9, gateDefinitionHash: "g", registryVersion: 3,
                 founderUserId: 4242 };
  const regenOk = nextPhase({ phase: "IMPL_PR_OPEN", generation: 2 },
    { kind: "founder.regenerate", snapshot: SNAP });
  check(regenOk.ok && regenOk.compensations.includes("adopt-snapshot"),
    "a regenerate with a resolved snapshot adopts it", JSON.stringify(regenOk));
  const regenBare = nextPhase({ phase: "IMPL_PR_OPEN", generation: 2 }, { kind: "founder.regenerate" });
  check(!regenBare.ok && /resolved registry snapshot/.test(regenBare.refusal ?? ""),
    "a regenerate with NO snapshot is refused before the generation bumps", JSON.stringify(regenBare));
  // A PARTIAL snapshot is the dangerous one: the fields it does carry are
  // correct, so it looks like it worked.
  for (const drop of Object.keys(SNAP)) {
    const partial = { ...SNAP }; delete partial[drop];
    const r = nextPhase({ phase: "IMPL_PR_OPEN", generation: 2 },
      { kind: "founder.regenerate", snapshot: partial });
    check(!r.ok && (r.refusal ?? "").includes(drop),
      `a regenerate missing ${drop} is refused, naming it`, JSON.stringify(r));
  }

  const gate = nextPhase({ phase: "GATE", generation: 1 }, { kind: "gate.capReached" });
  check(gate.ok && gate.to === "ESCALATED", "GATE -> ESCALATED at the revision cap", JSON.stringify(gate));

  // ESCALATED has exactly two kinds of entry edge. Anything else reaching it is
  // a hole. The EXACT set, not `every`: `entries.every(...)` is vacuously true on
  // an empty array and true on any subset, so a machine refusing exhausted
  // retries from four of the five worker phases would satisfy it.
  const entries = [];
  for (const phase of PHASES) for (const e of EVIDENCE) {
    const r = nextPhase({ phase, generation: 1, heldFrom: "IMPLEMENTING" }, e);
    if (r.ok && r.to === "ESCALATED") entries.push(`${phase}:${e.kind}`);
  }
  const WANT_ESCALATED = [
    "SIZING:phase.failed", "RESEARCH:phase.failed", "DESIGN:phase.failed",
    "SPEC_DRAFT:phase.failed", "IMPLEMENTING:phase.failed", "GATE:gate.capReached",
  ].sort();
  check(JSON.stringify([...new Set(entries)].sort()) === JSON.stringify(WANT_ESCALATED),
    "ESCALATED is entered by exactly the five worker phases' exhausted retries and GATE at the cap",
    `${[...new Set(entries)].sort().join(", ")} | want ${WANT_ESCALATED.join(", ")}`);

  // CANCELLING is excluded as a SOURCE from every 'any non-terminal' edge.
  for (const e of [{ kind: "hold", reason: "x" }, { kind: "founder.infeasible", reason: "r" }, { kind: "founder.cancel" }]) {
    const r = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 3 }, e);
    check(!r.ok, `CANCELLING refuses ${e.kind}: it exits only to CANCELLED`, JSON.stringify(r));
  }
  const draining = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 2 }, { kind: "drain.settled" });
  check(!draining.ok, "CANCELLING with rows still draining does not settle");
  const drained = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 0 }, { kind: "drain.settled" });
  check(drained.ok && drained.to === "CANCELLED", "and settles to CANCELLED only when the drain is empty", JSON.stringify(drained));
  const forced = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 5 }, { kind: "founder.cancelForce", drainEligible: true });
  check(forced.ok && forced.to === "CANCELLED", "--force is the one founder exit from CANCELLING");
  const tooSoon = nextPhase({ phase: "CANCELLING", generation: 1, drainRemaining: 5 }, { kind: "founder.cancelForce", drainEligible: false });
  check(!tooSoon.ok, "and it refuses before drainMinutes has passed, so rows are never recorded forced untried",
    JSON.stringify(tooSoon));

  // A bare phase report must not merge anything or finish anything.
  {
    const vw = nextPhase({ phase: "VERDICT_WAIT", generation: 1 }, { kind: "phase.succeeded", phase: "VERDICT_WAIT" });
    check(!vw.ok, "VERDICT_WAIT does not advance on phase.succeeded: merging needs the reconciler's witness", JSON.stringify(vw));
    const fz = nextPhase({ phase: "FINALIZING", generation: 1 }, { kind: "phase.succeeded", phase: "FINALIZING" });
    check(!fz.ok, "FINALIZING does not advance on phase.succeeded", JSON.stringify(fz));
    const busy = nextPhase({ phase: "FINALIZING", generation: 1 }, { kind: "finalize.settled", outstanding: 2 });
    check(!busy.ok, "nor while finalization effects are still unsettled", JSON.stringify(busy));
    const done = nextPhase({ phase: "FINALIZING", generation: 1 }, { kind: "finalize.settled", outstanding: 0 });
    check(done.ok && done.to === "DONE", "control: it reaches DONE once everything has settled", JSON.stringify(done));
  }

  // CLAIMING IS NOT ON THE SPINE, asserted rather than commented.
  //
  // `phase.succeeded` falls back to the ADVANCE map, so listing CLAIMING there
  // advances a bare report straight to SIZING and never reaches the claim.won
  // branch -- defeating the guard that refuses a claim carrying no ledger event
  // id and no projection generation. The totality matrix cannot see it: no
  // evidence in the table names CLAIMING as its source phase, so the cell that
  // would exercise the fallback is never visited, and a machine with CLAIMING on
  // the spine passes every other assertion in this file.
  {
    const bare = nextPhase({ phase: "CLAIMING", generation: 1 },
      { kind: "phase.succeeded", phase: "CLAIMING" });
    check(!bare.ok,
      "a phase report naming CLAIMING does not advance it: the claim needs its own witness",
      JSON.stringify(bare));
    // CONTROL, so this is not satisfied by a machine that refuses CLAIMING
    // outright: the witnessed edge still works.
    const won = nextPhase({ phase: "CLAIMING", generation: 1 },
      { kind: "claim.won", claimEventId: "e1", projectionGeneration: 7 });
    check(won.ok && won.to === "SIZING",
      "control: and the witnessed claim.won edge still reaches SIZING", JSON.stringify(won));
  }

  // There is no IMPLEMENTING -> SPEC_DRAFT edge. A plan that turns out wrong
  // mid-implementation is a founder decision, never an automatic respec.
  const respec = PHASES.filter(p => {
    const r = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "phase.failed", retriesExhausted: true });
    return r.ok && r.to === "SPEC_DRAFT";
  });
  check(respec.length === 0, "there is no IMPLEMENTING -> SPEC_DRAFT edge");

  // Both held states exit, and only --redesign bumps.
  for (const held of HELD) {
    const plain = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING" }, { kind: "founder.resume", redesign: false });
    check(plain.ok && plain.to === "IMPLEMENTING" && plain.generation === 3 && plain.bumps === false,
      `${held} + plain resume re-enters held_from at the SAME generation, so the approval survives`, JSON.stringify(plain));
    check(plain.compensations?.includes("clear-holds"), `${held} + resume clears the pr_hold rows`, JSON.stringify(plain));
    check(plain.compensations?.includes("regrant-territory"),
      `${held} + resume re-grants the territory released on entry`, JSON.stringify(plain));
    const conflicted = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING" },
      { kind: "founder.resume", redesign: false, territoryConflict: "bt:9" });
    check(!conflicted.ok && /bt:9/.test(conflicted.refusal ?? ""),
      `${held} + resume is refused when the territory now conflicts, naming the blocker`, JSON.stringify(conflicted));

    // A LEDGER-sourced task needs an affirmative, fresh ownership witness. A
    // negative-only guard admits a caller that never ran the sync at all, which
    // is the likelier bug: omitting an optional field is what a forgetful caller
    // does.
    const unverified = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", sourceKind: "ledger" },
      { kind: "founder.resume", redesign: false });
    check(!unverified.ok && /ledger sync/.test(unverified.refusal ?? ""),
      `${held} + a ledger resume with no ownership witness is refused`, JSON.stringify(unverified));
    const verified = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", sourceKind: "ledger" },
      { kind: "founder.resume", redesign: false, ownerIsReeve: true,
        // A witness is fresh RELATIVE to something. A bare timestamp asserted to
        // be "fresh" with neither a current time nor a bound could not have
        // distinguished a sync from a second ago from one from a year ago.
        ownershipSyncedAt: 1_800_000_000, now: 1_800_000_060, ownershipMaxAgeSeconds: 900 });
    check(verified.ok, `${held} + a ledger resume WITH a fresh witness proceeds`, JSON.stringify(verified));
    // CONTROL: the same witness, past the bound, is refused. Without it the
    // assertion above is satisfied by an implementation that ignores age
    // entirely.
    const stale = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", sourceKind: "ledger" },
      { kind: "founder.resume", redesign: false, ownerIsReeve: true,
        ownershipSyncedAt: 1_800_000_000, now: 1_800_000_000 + 86_400, ownershipMaxAgeSeconds: 900 });
    check(!stale.ok && /witness is/.test(stale.refusal ?? ""),
      `${held} + a ledger resume on a STALE witness is refused`, JSON.stringify(stale));
    // CONTROL, both directions: the founder-filed default is unaffected (the
    // plain resume above passed), and an explicit contrary owner still refuses.
    const humanOwned = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", sourceKind: "ledger" },
      { kind: "founder.resume", redesign: false, ownerIsReeve: true,
        ownershipSyncedAt: 1_800_000_000, ownerNotReeve: "someone" });
    check(!humanOwned.ok && /someone/.test(humanOwned.refusal ?? ""),
      `${held} + a ledger resume is still refused when a human owns the node`, JSON.stringify(humanOwned));

    const redesign = nextPhase({ phase: held, generation: 3, heldFrom: "IMPLEMENTING", hasOpenPr: true }, { kind: "founder.resume", redesign: true });
    check(redesign.ok && redesign.to === "DESIGN" && redesign.generation === 4 && redesign.bumps === true,
      `${held} + --redesign lands in DESIGN and bumps the generation`, JSON.stringify(redesign));
    check(redesign.compensations?.includes("close-prs"), "and closes the open slice PR");
  }

  // A hold arriving on an ALREADY-held task does not transition it: it stacks a
  // reason and keeps the original held_from. A transition here would rewrite
  // held_from and lose where the task should go back to.
  for (const held of HELD) {
    const r = nextPhase({ phase: held, generation: 1, heldFrom: "IMPLEMENTING" }, { kind: "hold", reason: "ownership_lost" });
    check(!r.ok, `a hold on an already-${held} task does not transition it`, JSON.stringify(r));
    check(/stack|already held/i.test(r.refusal ?? ""), "and says so, so the caller appends a hold_reason instead", String(r.refusal));
    check(r.stackable === true, "and marks the refusal STACKABLE, so applyTransition knows to append a reason");
    // An unknown reason must be refused BEFORE the already-held check, not after
    // it: `hold_reason.reason` is a closed CHECK, so a refusal marked stackable
    // with a bogus reason reaches the constraint and THROWS out of the
    // transaction instead of returning a refusal the caller can render.
    const bogusStack = nextPhase({ phase: held, generation: 1, heldFrom: "IMPLEMENTING" },
      { kind: "hold", reason: "because" });
    check(!bogusStack.ok && !bogusStack.stackable && /unknown hold reason/.test(bogusStack.refusal ?? ""),
      `an unknown reason on an already-${held} task is refused, not stacked`, JSON.stringify(bogusStack));
  }

  // Every hold cause raises ITS OWN identity. A generic BLOCKED with no
  // escalation is a task that stops and waits for a founder who was never told,
  // and BLOCKED has no automatic exit.
  for (const [reason, why] of [
    ["ownership_lost",      "bt:<id>:intake:ownership-lost"],
    ["harness_touched",     "bt:<id>:impl:harness-touched"],
    ["over_budget",         "bt:<id>:impl:over-budget"],
    ["depth_post_approval", "bt:<id>:depth:post-approval"],
    ["reopen",              "bt:<id>:spec:reopened"],
  ]) {
    const h = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "hold", reason });
    check(h.ok && h.escalate === why, `a ${reason} hold raises ${why}`, JSON.stringify(h));
  }
  // blocked_other carries the identity the CALLER determined -- the DDL gives
  // pr_hold a `detail` column for exactly this -- and refuses without one.
  const other = nextPhase({ phase: "IMPLEMENTING", generation: 1 },
    { kind: "hold", reason: "blocked_other", escalation: "bt:<id>:lease:conflict" });
  check(other.ok && other.escalate === "bt:<id>:lease:conflict",
    "a blocked_other hold raises the identity its caller supplied", JSON.stringify(other));
  const nameless = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "hold", reason: "blocked_other" });
  check(!nameless.ok, "and a blocked_other hold with no identity is REFUSED, not held silently", JSON.stringify(nameless));
  // CONTROL: the map is closed against pr_hold's CHECK set, so a reason outside
  // it is a refusal rather than a hold with no name.
  const bogus = nextPhase({ phase: "IMPLEMENTING", generation: 1 }, { kind: "hold", reason: "because" });
  check(!bogus.ok && /unknown hold reason/.test(bogus.refusal ?? ""),
    "control: a reason outside pr_hold's CHECK set is refused", JSON.stringify(bogus));

  // ESCALATED voids nothing; BLOCKED voids pending rows. Both release territory.
  const blocked = nextPhase({ phase: "IMPLEMENTING", generation: 1, hasOpenPr: true }, { kind: "hold", reason: "over_budget" });
  check(blocked.ok && blocked.to === "BLOCKED" && blocked.compensations.includes("void-pending"),
    "BLOCKED voids pending cancellable rows", JSON.stringify(blocked));
  const esc = nextPhase({ phase: "IMPLEMENTING", generation: 1, hasOpenPr: true }, { kind: "phase.failed", retriesExhausted: true });
  check(esc.ok && esc.to === "ESCALATED" && !esc.compensations.includes("void-pending"),
    "ESCALATED voids NOTHING: the phase merely stopped, and its effects stand", JSON.stringify(esc));

  // A trivial filing skips RESEARCH, and the skip is recorded rather than merely
  // implied by a missing artifact.
  const triv = nextPhase({ phase: "SIZING", generation: 1 },
    { kind: "phase.succeeded", phase: "SIZING", depth: "trivial" });
  check(triv.ok && triv.to === "DESIGN", "a trivial filing goes straight from SIZING to DESIGN", JSON.stringify(triv));
  check(triv.compensations.includes("record-research-skip"),
    "and emits record-research-skip, so the absent research artifact has a durable reason",
    JSON.stringify(triv.compensations));

  check(esc.escalate === "bt:<id>:phase:failed:IMPLEMENTING",
    "and it carries the phase-specific escalation identity the interface promises", String(esc.escalate));
  check(esc.compensations.includes("write-pr-hold") && esc.compensations.includes("release-territory"),
    "but still holds the PR and releases the territory, so a founder who is away does not starve every overlapping task",
    JSON.stringify(esc));
  const pinned = nextPhase({ phase: "IMPLEMENTING", generation: 1, hasOpenPr: true, pinnedTerritory: true }, { kind: "phase.failed", retriesExhausted: true });
  check(!pinned.compensations.includes("release-territory"), "unless a live --pin-territory holds it");

  // A retry that has NOT exhausted its budget is not a transition at all.
  const retry = nextPhase({ phase: "RESEARCH", generation: 1 }, { kind: "phase.failed", retriesExhausted: false });
  check(!retry.ok, "control: a failed attempt with retries left does not transition; it is a new attempt");
}

console.log(fail ? `\nfailed=${fail}` : "\nall green");
process.exit(fail ? 1 : 0);
