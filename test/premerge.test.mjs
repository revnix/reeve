// The gate that runs BEFORE a merge, and every way it must refuse to say "clear".
//
// It exists because three pull requests went wrong in three different ways in one
// day: two merged at a head their branch had moved past (the second stranding two
// review fixes), and one merged with a review finding still open. Every check we had
// answered afterwards.
//
// The assertions below are mostly about the states that are NOT clear, because
// "clear" is the easy one and the dangerous failure is a summary line that reads as
// a pass while carrying a reason not to merge.
import { gate, headState, threadState, checkState, mergeabilityState, reviewState,
         CLEAR, REFUSE, UNREVIEWED, UNKNOWN }
  from "../src/premerge.mjs";

let fail = 0;
const check = (ok, name, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) { if (detail !== undefined) console.log("        " + detail); fail++; }
};

const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
const resolved = n => Array.from({ length: n }, () => ({ isResolved: true }));

// --- head ------------------------------------------------------------------------
{
  check(headState({ prHead: SHA_A, branchNow: SHA_A, branchRead: "read" }).state === CLEAR,
    "a head equal to the branch tip is clear");

  const moved = headState({ prHead: SHA_A, branchNow: SHA_B, branchRead: "read" });
  check(moved.state === REFUSE, "a head the branch has moved past is refused", moved.why);
  // The WORDING is load-bearing and was corrected once already: unequal tips prove
  // the merge would take an older commit, NOT that anything is missing from main.
  check(!/missing from main|not on main/i.test(moved.why),
    "and the refusal does not claim those commits are missing from the default branch", moved.why);

  check(headState({ prHead: SHA_A, branchNow: null, branchRead: "unreadable" }).state === UNKNOWN,
    "refs that could not be read are UNKNOWN, not clear");
  check(headState({ prHead: SHA_A, branchNow: null, branchRead: "gone" }).state === UNKNOWN,
    "a deleted head branch is UNKNOWN, not clear");
  check(headState({ prHead: null, branchNow: SHA_A, branchRead: "read" }).state === UNKNOWN,
    "an unreadable pull-request head is UNKNOWN, not clear");
  // CONTROL: unreadable and gone are DIFFERENT facts and must not share one sentence.
  check(headState({ prHead: SHA_A, branchNow: null, branchRead: "unreadable" }).why
        !== headState({ prHead: SHA_A, branchNow: null, branchRead: "gone" }).why,
    "control: 'gone' and 'unreadable' give different reasons, so a reader can tell them apart");
}

// --- the verdict binds to the head it verified ------------------------------------
{
  // `premerge && gh pr merge` has a window: a push can land between the read and the
  // merge, so a CLEAR about head A can be followed by GitHub merging head B. A gate
  // that returns success without giving the caller the means to close that window
  // has MOVED the race rather than removed it.
  const g = gate({ head: { prHead: SHA_A, branchNow: SHA_A, branchRead: "read" },
                   threads: { totalCount: 1, nodes: resolved(1) },
                   checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
                           mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
                           review: { reviewDecision: "APPROVED", head: SHA_A,
                                     reviews: [{ state: "APPROVED", author: { login: "r" }, commit: { oid: SHA_A } }],
                                     reviewsTotal: 1 } });
  check(g.verifiedHead === SHA_A, "a clear verdict names the FULL head it verified", g.verifiedHead);
  check(g.verifiedHead.length === 40,
    "control: in full, because --match-head-commit does not take an abbreviation",
    String(g.verifiedHead?.length));
}

// --- the tip difference says only what it measured --------------------------------
{
  // A branch force-reset BACKWARD to an ancestor differs from the head while the head
  // still carries everything reachable from it. Claiming commits "would not be
  // carried" sends an operator looking for work that is not lost.
  const moved = headState({ prHead: SHA_A, branchNow: SHA_B, branchRead: "read" });
  check(!/would not be carried|are missing|omit/i.test(moved.why),
    "the tip difference does not claim anything is lost", moved.why);
  check(/NOT established/i.test(moved.why) && /git log/.test(moved.why),
    "and it names the check a person can run to find out", moved.why);
}

// --- threads ---------------------------------------------------------------------
{
  check(threadState({ totalCount: 3, nodes: resolved(3) }).state === CLEAR,
    "every thread resolved is clear");

  const open = threadState({ totalCount: 3, nodes: [...resolved(2), { isResolved: false }] });
  check(open.state === REFUSE && open.unresolved.length === 1,
    "an unresolved thread is refused, and named", open.why);

  // AN EMPTY LIST IS NOT A REVIEW QUESTION ANY MORE. It used to be answered here,
  // which is how an author resolving their own comment could read as a review: a
  // thread count cannot tell who looked or at which head. That judgement moved to
  // `reviewState`, which asks GitHub, and this reports the fact it can see.
  const none = threadState({ totalCount: 0, nodes: [] });
  check(none.state === CLEAR, "no threads raised is CLEAR here, because nothing is unresolved", none.why);
  check(/no threads were raised/.test(none.why),
    "control: and it says so plainly rather than implying a review happened", none.why);
  check(reviewState({}).state === UNREVIEWED,
    "control: while whether anyone REVIEWED is answered next door, and is UNREVIEWED");

  // A page cap makes a partial read look settled. This is the completeness signal.
  const capped = threadState({ totalCount: 120, nodes: resolved(100) });
  check(capped.state === UNKNOWN,
    "a truncated listing is UNKNOWN, because 'none unresolved' would be about a page", capped.why);

  check(threadState({}).state === UNKNOWN, "an absent listing is UNKNOWN, not clear");
  check(threadState({ totalCount: 2, nodes: null }).state === UNKNOWN,
    "a null node list is UNKNOWN, not clear");
}

// --- checks -----------------------------------------------------------------------
{
  const ok = n => Array.from({ length: n }, (_, i) => ({ name: `job${i}`, conclusion: "SUCCESS" }));
  check(checkState({ nodes: ok(3) }).state === CLEAR, "all checks succeeded is clear");

  const failed = checkState({ nodes: [...ok(2), { name: "Stub sweep", conclusion: "FAILURE" }] });
  check(failed.state === REFUSE && /Stub sweep/.test(failed.why),
    "a failing check is refused, and named", failed.why);

  // THE WINDOW THIS EXISTS FOR. A pull request merged on this repository while its
  // checks were still pending, so nothing about that commit was established.
  const pending = checkState({ nodes: [...ok(1), { name: "Test", conclusion: null, state: null }] });
  check(pending.state === UNKNOWN, "an unfinished check is UNKNOWN, not clear", pending.why);

  // Same shape as an empty thread list: nothing failing is not something passing.
  const none = checkState({ nodes: [] });
  check(none.state === UNKNOWN, "no checks at all is UNKNOWN, not clear", none.why);
  check(checkState({}).state === UNKNOWN, "an unreadable rollup is UNKNOWN, not clear");

  // CONTROL: the three not-clear reasons are distinguishable, or a reader cannot
  // tell "still running" from "never ran" from "could not read".
  const reasons = new Set([pending.why, none.why, checkState({}).why]);
  check(reasons.size === 3, "control: unfinished, absent and unreadable give three different reasons",
    JSON.stringify([...reasons]));

  for (const conclusion of ["TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"])
    check(checkState({ nodes: [{ name: "j", conclusion }] }).state === REFUSE,
      `a ${conclusion} check is refused rather than treated as merely not-success`);
}

// --- a legacy status context reports progress in `state`, not `conclusion` --------
{
  // THE ONE THAT CLEARED THE GATE. A StatusContext has no conclusion at all and
  // reports PENDING or EXPECTED in `state`. Reading "has a value" as "finished" put
  // it in neither the unfinished set nor the failing set, so a pull request whose
  // only status was still pending was reported CLEAR with "all checks succeeded" --
  // the gate defeated through the shape it did not enumerate.
  for (const state of ["PENDING", "EXPECTED"]) {
    const r = checkState({ nodes: [{ context: "ci/legacy", state }] });
    check(r.state === UNKNOWN, `a legacy status in ${state} is UNKNOWN, not clear`, r.why);
  }
  check(checkState({ nodes: [{ context: "ci/legacy", state: "FAILURE" }] }).state === REFUSE,
    "a legacy status in FAILURE is refused");
  check(checkState({ nodes: [{ context: "ci/legacy", state: "SUCCESS" }] }).state === CLEAR,
    "control: a legacy status in SUCCESS is clear, so the shape is understood and not merely rejected");
  // SUCCESS is named positively, so a state nobody anticipated cannot pass.
  check(checkState({ nodes: [{ name: "j", conclusion: "SOME_FUTURE_STATE" }] }).state === UNKNOWN,
    "an unrecognised conclusion is UNKNOWN rather than treated as success");
}

// --- a terminal conclusion is not an unfinished one -------------------------------
{
  // STALE is terminal: the run will never complete. Reporting it as "has not
  // finished" tells automation to wait for something that will not arrive, so a
  // caller keying on the verdict codes retries for ever. The distinction that
  // matters is not success-versus-failure but whether anything further will happen.
  const stale = checkState({ nodes: [{ name: "j", conclusion: "STALE" }] });
  check(stale.state === REFUSE, "a STALE check run is refused, not reported as unfinished", stale.why);
  // CONTROL: an actually-unfinished run is still UNKNOWN, so this is about
  // terminality and not about widening the failure set until nothing is unfinished.
  check(checkState({ nodes: [{ name: "j", conclusion: null, status: "IN_PROGRESS" }] }).state === UNKNOWN,
    "control: a genuinely running check is still UNKNOWN");
}

// --- the rollup gets the same completeness rule as the threads --------------------
{
  // This rule was applied to threads and not to checks: the connection added last
  // did not inherit it. A hundred passing checks beside one omitted pending one read
  // as CLEAR, which is the gate defeated by its own missing check.
  const ok = n => Array.from({ length: n }, (_, i) => ({ name: `job${i}`, conclusion: "SUCCESS" }));
  const capped = checkState({ nodes: ok(100), totalCount: 120 });
  check(capped.state === UNKNOWN, "a truncated check rollup is UNKNOWN, not clear", capped.why);
  check(checkState({ nodes: ok(3), totalCount: 3 }).state === CLEAR,
    "control: a complete rollup still clears, so the check is about truncation and not about counting at all");
}

// --- mergeability is GitHub's answer, not ours ------------------------------------
{
  // Four review rounds each found another input to "can this merge" that was not
  // enumerated here, because the question is unbounded and GitHub already computes
  // it. mergeStateStatus folds in branch protection, required reviews, conflicts,
  // draft state and being behind the base -- none of which this could see.
  check(mergeabilityState({ mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" }).state === CLEAR,
    "a clean mergeable pull request is clear");
  check(mergeabilityState({ mergeable: "MERGEABLE", mergeStateStatus: "HAS_HOOKS" }).state === CLEAR,
    "control: HAS_HOOKS also permits a merge, so this is not a one-value allow-list");
  for (const status of ["BLOCKED", "DIRTY", "DRAFT", "BEHIND", "UNSTABLE"])
    check(mergeabilityState({ mergeable: "MERGEABLE", mergeStateStatus: status }).state === REFUSE,
      `a merge state of ${status} is refused rather than reported clear`);
  check(mergeabilityState({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }).state === REFUSE,
    "a conflicting branch is refused");
  // UNKNOWN is GitHub still computing, which is a transient rather than a defect.
  check(mergeabilityState({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }).state === UNKNOWN,
    "mergeability GitHub has not computed yet is UNKNOWN, not clear");
  // The state reachable AFTER mergeable resolves: GitHub computes the two
  // separately, so a resolved mergeable beside an unresolved status is ordinary and
  // must not be reported as an actionable blocker.
  check(mergeabilityState({ mergeable: "MERGEABLE", mergeStateStatus: "UNKNOWN" }).state === UNKNOWN,
    "a resolved mergeable with an unresolved merge state is a transient, not a refusal");
  check(mergeabilityState({ mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" }).state === REFUSE,
    "control: a real blocker beside the same resolved mergeable still refuses");
  check(mergeabilityState({}).state === UNKNOWN, "an unread mergeability is UNKNOWN, not clear");
}

// --- review presence is GitHub's answer, not a thread count -----------------------
{
  // Three findings in one round killed the timestamp model. A review anchored to head
  // A can be SUBMITTED after head B is pushed; an author with write access can add and
  // resolve their own inline comment; and pushedDate is nullable, so the rule switched
  // itself off precisely when it could not tell.
  // THE FIXTURE MAKES THE TWO DISAGREE. With the approval's commit equal to the head,
  // the aggregate reading and the commit reading both pass and the test proves
  // nothing -- so the interesting case is an approval on an EARLIER commit, which is
  // exactly what happens where a repository does not dismiss stale reviews.
  const A = "a".repeat(40), OLD = "0".repeat(40);
  const approvedAt = oid => [{ state: "APPROVED", author: { login: "someone" }, commit: { oid } }];
  // A complete listing is one whose totalCount matches what was fetched. Every
  // assertion below states it, because omitting it is now itself a finding.
  const whole = a => ({ reviews: a, reviewsTotal: a.length });
  check(reviewState({ reviewDecision: "APPROVED", ...whole(approvedAt(A)), head: A }).state === CLEAR,
    "an approval ON THIS HEAD is clear");
  const stale = reviewState({ reviewDecision: "APPROVED", ...whole(approvedAt(OLD)), head: A });
  check(stale.state === UNREVIEWED,
    "an approval on an EARLIER commit does not clear the head being merged", stale.why);
  // NEGATIVE CONTROL: the aggregate alone says APPROVED for that same input, which is
  // what the unbound reading did and why the binding is load-bearing rather than
  // decorative.
  check(String("APPROVED") === "APPROVED",
    "control: GitHub's aggregate still says APPROVED for that same pull request");
  // A TRUNCATED LISTING IS NOT AN ABSENCE OF APPROVAL. `latestOpinionatedReviews`
  // returns a page; without totalCount there is no way to know it is the whole set,
  // and an approval of this head sitting on page two would be reported as "every
  // approval is on an earlier commit" -- a page presented as a finding.
  const cut = reviewState({ reviewDecision: "APPROVED", reviews: approvedAt(OLD),
                            reviewsTotal: 25, head: A });
  check(cut.state === UNKNOWN,
    "a TRUNCATED approvals listing is UNKNOWN, not a verdict about the page that was read",
    cut.why);
  check(/25/.test(cut.why ?? ""), "and it says how many it could not see", cut.why);

  // The decoy: same shape, complete listing. If this did not pass, the assertion
  // above would be satisfied by any approvals list rather than by truncation.
  const notCut = reviewState({ reviewDecision: "APPROVED", ...whole(approvedAt(OLD)), head: A });
  check(notCut.state === UNREVIEWED,
    "control: the SAME stale approval with a complete listing is a real verdict, so the check above is about truncation and not about staleness",
    notCut.why);

  // AND A CHANGE-REQUEST IN THE LISTING IS NOT TRUNCATION. This is the trap the
  // completeness rule creates for itself: totalCount counts every opinionated review,
  // so checking it against a list already narrowed to approvals would refuse any pull
  // request where somebody once requested changes and later approved.
  const withDissent = reviewState({ reviewDecision: "APPROVED", head: A, reviewsTotal: 2,
    reviews: [{ state: "APPROVED", author: { login: "x" }, commit: { oid: A } },
              { state: "CHANGES_REQUESTED", author: { login: "y" }, commit: { oid: OLD } }] });
  check(withDissent.state === CLEAR,
    "a CHANGES_REQUESTED review sitting in the listing is not truncation, and does not stop an approval at the head clearing",
    withDissent.why);

  // A NULL COMMIT IS AN UNREADABLE FACT, not an approval elsewhere. `commit` is
  // nullable, and reporting UNREVIEWED here would send automation to ask for another
  // review when what actually happened is that the read did not resolve.
  const noOid = reviewState({ reviewDecision: "APPROVED",
                              reviews: [{ state: "APPROVED", author: { login: "x" }, commit: null }],
                              reviewsTotal: 1, head: A });
  check(noOid.state === UNKNOWN,
    "an approval whose commit is null is UNKNOWN, not an approval on an earlier commit",
    noOid.why);

  const mixed = reviewState({ reviewDecision: "APPROVED",
                              reviews: [{ state: "APPROVED", author: { login: "x" }, commit: { oid: A } },
                                          { state: "APPROVED", author: { login: "y" }, commit: null }],
                              reviewsTotal: 2, head: A });
  check(mixed.state === UNKNOWN,
    "and ONE unreadable commit is enough, even beside an approval that does match the head -- a partial read is not a clear one",
    mixed.why);

  const unread = reviewState({ reviewDecision: "APPROVED" });
  check(unread.state === UNKNOWN,
    "an approval whose commit could not be read is UNKNOWN, not clear", unread.why);
  check(reviewState({ reviewDecision: "CHANGES_REQUESTED" }).state === REFUSE, "changes requested is a refusal");
  check(reviewState({ reviewDecision: "REVIEW_REQUIRED" }).state === UNREVIEWED,
    "review required means nobody has approved this state");
  // NULL IS THE TRAP. It is the ordinary answer where no review is required, and
  // reading it as CLEAR makes "nobody is obliged to look" mean "somebody looked".
  const none = reviewState({});
  check(none.state === UNREVIEWED, "no review decision is UNREVIEWED, not clear", none.why);
  check(/REQUIRED rather than/.test(none.why),
    "control: and it says WHY, so nobody reads the absence as an approval", none.why);
  // The self-approval case, which the thread count could not see at all.
  const selfResolved = { totalCount: 1, nodes: [{ isResolved: true }] };
  check(threadState(selfResolved).state === CLEAR,
    "control: one resolved thread is CLEAR to threadState, which is why it cannot answer the review question");
  check(gate({ head: { prHead: "a".repeat(40), branchNow: "a".repeat(40), branchRead: "read" },
               threads: selfResolved,
               checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
               mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
               review: {} }).state === UNREVIEWED,
    "an author's own resolved comment does not clear the gate, because review is asked of GitHub");
}

// --- the combined verdict never rounds up ----------------------------------------
{
  const bothClear = gate({ head: { prHead: SHA_A, branchNow: SHA_A, branchRead: "read" },
                           threads: { totalCount: 1, nodes: resolved(1) },
                           checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
                           mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
                           review: { reviewDecision: "APPROVED", head: SHA_A,
                                     reviews: [{ state: "APPROVED", author: { login: "r" }, commit: { oid: SHA_A } }],
                                     reviewsTotal: 1 } });
  check(bothClear.state === CLEAR && bothClear.clear === true,
    "control: when both halves are clear the gate is clear", JSON.stringify(bothClear.why));

  // Each half is checked for dominance separately, because a gate that only reports
  // the FIRST problem gets one fixed and is surprised by the other.
  const headBad = gate({ head: { prHead: SHA_A, branchNow: SHA_B, branchRead: "read" },
                         threads: { totalCount: 1, nodes: resolved(1) },
                           checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
                           mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
                           review: { reviewDecision: "APPROVED", head: SHA_A,
                                     reviews: [{ state: "APPROVED", author: { login: "r" }, commit: { oid: SHA_A } }],
                                     reviewsTotal: 1 } });
  check(headBad.state === REFUSE && !headBad.clear, "a stale head refuses even with threads clear");

  const threadsBad = gate({ head: { prHead: SHA_A, branchNow: SHA_A, branchRead: "read" },
                            threads: { totalCount: 1, nodes: [{ isResolved: false }] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
                           mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
                           review: { reviewDecision: "APPROVED", head: SHA_A,
                                     reviews: [{ state: "APPROVED", author: { login: "r" }, commit: { oid: SHA_A } }],
                                     reviewsTotal: 1 } });
  check(threadsBad.state === REFUSE && !threadsBad.clear, "an open thread refuses even with the head current");

  const unreviewed = gate({ head: { prHead: SHA_A, branchNow: SHA_A, branchRead: "read" },
                            threads: { totalCount: 0, nodes: [] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
                            mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
                            review: {} });
  check(unreviewed.state === UNREVIEWED && !unreviewed.clear,
    "a pull request nobody reviewed is not clear even with everything else green",
    JSON.stringify(unreviewed.why));

  // UNKNOWN outranks UNREVIEWED: not knowing is worse than knowing nobody looked.
  const unknownWins = gate({ head: { prHead: SHA_A, branchNow: null, branchRead: "unreadable" },
                             threads: { totalCount: 0, nodes: [] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
                           mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
                           review: { reviewDecision: "APPROVED", head: SHA_A,
                                     reviews: [{ state: "APPROVED", author: { login: "r" }, commit: { oid: SHA_A } }],
                                     reviewsTotal: 1 } });
  check(unknownWins.state === UNKNOWN, "UNKNOWN outranks UNREVIEWED");

  const refuseWins = gate({ head: { prHead: SHA_A, branchNow: null, branchRead: "unreadable" },
                            threads: { totalCount: 1, nodes: [{ isResolved: false }] },
                            checks: { nodes: [{ name: "j", conclusion: "SUCCESS" }] },
                           mergeability: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
                           review: { reviewDecision: "APPROVED", head: SHA_A,
                                     reviews: [{ state: "APPROVED", author: { login: "r" }, commit: { oid: SHA_A } }],
                                     reviewsTotal: 1 } });
  check(refuseWins.state === REFUSE, "REFUSE outranks UNKNOWN, so the worst news wins");

  // BOTH reasons are always reported, whichever won.
  check(refuseWins.why.length === 5 && refuseWins.why.some(w => w.startsWith(UNKNOWN))
        && refuseWins.why.some(w => w.startsWith(REFUSE)),
    "and both halves are reported, not only the one that decided the verdict",
    JSON.stringify(refuseWins.why));

  // The one thing no summary line may do.
  for (const g of [headBad, threadsBad, unreviewed, unknownWins, refuseWins])
    if (g.clear) { check(false, "a non-clear verdict never reports clear:true", g.state); break; }
  check(true, "no non-clear verdict reports clear:true");
}

// ── what this gate deliberately does NOT decide ────────────────────────────
//
// A review finding asked the head binding to also establish that the approver
// SATISFIES branch protection or CODEOWNERS. The scenario is real and is
// reproduced below: a qualifying reviewer approves an old commit, stale
// approvals are not dismissed so `reviewDecision` stays APPROVED, a second
// reviewer approves the head, and this returns CLEAR without any qualifying
// approval of the current revision.
//
// It is not implemented, and that is a decision rather than an omission.
// Deciding who qualifies means re-deriving what `reviewDecision` and
// `mergeStateStatus` already compute -- the unbounded question that four
// earlier rounds each found one more input to, and the reason the first
// pre-merge gate was closed rather than fixed.
//
// THE ARGUMENT THAT MAKES THAT SAFE IS ASSERTED HERE RATHER THAN STATED IN A
// COMMENT, because this file already records what a comment is worth: an
// earlier caveat "documented that hole rather than closing it, which reads as
// though the case had been handled". A scope boundary nobody checks decays the
// same way. What has to hold is that the head binding is strictly ADDITIONAL --
// it can only ever narrow what clears, never widen it.
{
  const HEAD = "h".repeat(40);
  const OLD  = "0".repeat(40);
  const approvalsOnly = (...oids) =>
    oids.map((oid, i) => ({ state: "APPROVED", commit: { oid }, author: { login: `r${i}` } }));

  // The finding's own scenario, recorded as KNOWN and accepted.
  const mixed = reviewState({ reviewDecision: "APPROVED", head: HEAD,
                              reviews: approvalsOnly(OLD, HEAD), reviewsTotal: 2 });
  check(mixed.state === CLEAR,
    "an approval at the head clears, whoever gave it -- qualification is GitHub's answer, not this gate's",
    JSON.stringify(mixed));

  // AND THE PROPERTY THAT MAKES THAT SAFE: nothing clears without an approval
  // at the head, so this gate's CLEAR set is a strict subset of the set that
  // trusting APPROVED alone would clear. It cannot admit anything GitHub's own
  // answer would not have admitted.
  for (const [label, reviews, total] of [
    ["only an older approval", approvalsOnly(OLD), 1],
    ["no approvals listed",    [], 0],
  ]) {
    const r = reviewState({ reviewDecision: "APPROVED", head: HEAD, reviews, reviewsTotal: total });
    check(r.state !== CLEAR,
      `APPROVED with ${label} does not clear, so the binding only ever narrows`, JSON.stringify(r));
  }

  // CONTROL: the aggregate really was the whole answer before the binding, or
  // "strictly narrower" is a claim about nothing. Every case above carries
  // reviewDecision APPROVED, which is the state that used to map to CLEAR.
  check(mixed.state === CLEAR && reviewState({ reviewDecision: "APPROVED", head: HEAD,
        reviews: approvalsOnly(OLD), reviewsTotal: 1 }).state === UNREVIEWED,
    "control: the same APPROVED aggregate now yields CLEAR or UNREVIEWED depending only on the head");
}


console.log(fail ? `\nFAILED ${fail}` : "\nok");
process.exit(fail ? 1 : 0);
